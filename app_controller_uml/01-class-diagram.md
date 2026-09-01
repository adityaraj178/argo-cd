# 1. Structure — UML class diagram

Types declared in `controller/appcontroller.go` and their methods. `AppStateManager`
is declared elsewhere (`controller/state.go`) but shown because the controller
delegates all compare and sync work to it.

Concurrency markers follow the legend in `README.md`. Only **goroutine entry
points** and **serialization primitives** are marked; an unmarked method inherits
the concurrency of whichever caller reached it.

```mermaid
classDiagram
    direction LR

    class Legend {
        <<concurrency notation>>
        P xN : parallel, N goroutines
        S x1 : serial, one goroutine
        1/key : one in-flight per app key
        LOCK : mutex-serialized
        SEM N : semaphore-bounded
        ANY : many caller goroutines
    }

    class ApplicationController {
        -appRefreshQueue: Queue~string~
        -appComparisonTypeRefreshQueue: Queue~string~
        -appOperationQueue: Queue~string~
        -projectRefreshQueue: Queue~string~
        -appHydrateQueue: Queue~string~
        -hydrationQueue: Queue~HydrationQueueKey~
        -appInformer: SharedIndexInformer
        -projInformer: SharedIndexInformer
        -appStateManager: AppStateManager
        -stateCache: LiveStateCache
        -clusterSharding: ClusterShardingCache
        -projByNameCache: sync.Map [LOCK]
        -refreshRequestedApps: map~string,CompareWith~ [LOCK]
        -refreshRequestedAppsMutex: sync.Mutex
        -kubectlSemaphore: semaphore.Weighted [SEM 20]
        -hydrator: Hydrator
        +Run(ctx, statusProcessors, operationProcessors) [S x1, spawns all]
        +InvalidateProjectsCache(names...) [LOCK]
        +GetMetricsServer() MetricsServer
        +RegisterClusterSecretUpdater(ctx) [spawns goroutine]
        +PatchAppWithWriteBack(...) Application [ANY]
        -processAppRefreshQueueItem() bool [P x20] [1/key]
        -processAppOperationQueueItem() bool [P x10] [1/key]
        -processAppComparisonTypeQueueItem() bool [S x1]
        -processProjectQueueItem() bool [S x1]
        -processAppHydrateQueueItem() bool [S x1]
        -processHydrationQueueItem() bool [S x1]
        -requestAppRefresh(name, level, after) [ANY] [LOCK]
        -isRefreshRequested(name) bool, CompareWith [LOCK]
        -needRefreshAppStatus(app, soft, hard) bool, RefreshType, CompareWith
        -refreshAppConditions(app) AppProject, bool
        -autoSync(app, syncStatus, resources, cmpRevs) Condition, Duration
        -processRequestedAppOperation(app)
        -setOperationState(app, state)
        -finalizeApplicationDeletion(app, projectClusters) error
        -finalizeProjectDeletion(proj) error
        -removeProjectFinalizer(proj) error
        -updateFinalizers(app) error
        -persistAppStatus(orig, newStatus) Duration
        -normalizeApplication(app)
        -setAppManagedResources(destCluster, app, cmpResult) ApplicationTree
        -getResourceTree(destCluster, app, managedResources) ApplicationTree
        -getAppHosts(destCluster, app, appNodes) HostInfo[]
        -hideSecretData(destCluster, app, cmpResult) ResourceDiff[]
        -getPermittedAppLiveObjects(...) map
        -shouldBeDeleted(app, obj) bool
        -getAppProj(app) AppProject [ANY] [LOCK]
        -newAppProjCache(name) appProjCache [ANY]
        -handleObjectUpdated(managedByApp, ref) [P per-cluster]
        -canProcessApp(obj) bool [ANY]
        -isAppNamespaceAllowed(app) bool [ANY]
        -newApplicationInformerAndLister() Informer, Lister
        -onKubectlRun(command) CleanupFunc [ANY] [SEM 20]
        -writeBackToInformer(app) [ANY]
        -setAppCondition(app, condition)
        -projectErrorToCondition(err, app) Condition
        -toAppKey(appName) string
        -toAppQualifiedName(appName, appNamespace) string
        -getAppList(options) ApplicationList
        -logAppEvent(ctx, app, eventInfo, message)
    }

    class appProjCache {
        <<LOCK per project entry>>
        -name: string
        -ctrl: ApplicationController
        -lock: sync.Mutex
        -appProj: AppProject
        +GetAppProject(ctx) AppProject [ANY] [LOCK]
    }

    class CompareWith {
        <<enumeration, immutable>>
        ComparisonWithNothing = 0
        CompareWithRecent = 1
        CompareWithLatest = 2
        CompareWithLatestForceResolve = 3
        +Max(b) CompareWith
        +Pointer() *CompareWith
    }

    class PackageFunctions {
        <<utility, stateless>>
        +isSelfReferencedApp(app, ref) bool
        +isKnownOrphanedResourceExclusion(key, proj) bool
        +resourceStatusKey(res) string
        +currentSourceEqualsSyncedSource(app) bool
        +createMergePatch(orig, newV) bytes, bool, error
        +alreadyAttemptedSync(app, desiredRevs, hasChanges) bool, string[], Phase
        +isOperationInProgress(app) bool
        +automatedSyncEnabled(oldApp, newApp) bool
    }

    class ControllerBackoffMethods {
        <<ApplicationController>>
        -selfHealRemainingBackoff(app, attempts) Duration
        -selfHealBackoffCooldownElapsed(app) bool
    }

    class AppStateManager {
        <<interface>>
        +CompareAppState(...) comparisonResult
        +SyncAppState(app, proj, state)
    }

    ApplicationController "1" --> "*" appProjCache : projByNameCache [LOCK]
    appProjCache --> ApplicationController : back-ref for db and projInformer
    ApplicationController --> AppStateManager : delegates compare and sync
    ApplicationController ..> CompareWith : uses
    ApplicationController ..> PackageFunctions : uses
    ApplicationController ..> ControllerBackoffMethods : self-heal timing
```

## Notes

- `appProjCache` holds a back-pointer to the controller so a cache miss can reach
  `projInformer` and `db`. That makes the relationship genuinely bidirectional.
- `hydrator` being nil is the feature flag. Every hydration path checks
  `ctrl.hydrator != nil` before touching it.
- `deploymentInformer` is only non-nil when `dynamicClusterDistributionEnabled` is
  set, which is why each use is guarded.

## Concurrency classes

Six worker methods are goroutine entry points, spawned in `Run` (lines 929-962).
Everything else is reached *from* one of them, from an informer handler, or from a
live-state-cache callback.

| Method | Goroutines | Source |
|---|---|---|
| `processAppRefreshQueueItem` | `statusProcessors`, default **20** | `for i := 0; i < statusProcessors; i++` |
| `processAppOperationQueueItem` | `operationProcessors`, default **10** | `for i := 0; i < operationProcessors; i++` |
| `processAppComparisonTypeQueueItem` | **1** | single `go wait.Until` |
| `processProjectQueueItem` | **1** | single `go wait.Until` |
| `processAppHydrateQueueItem` | **1**, only if `hydrator != nil` | single `go wait.Until` |
| `processHydrationQueueItem` | **1**, only if `hydrator != nil` | single `go wait.Until` |

Non-worker entry points, which is where the surprises live:

| Entry point | Goroutine model |
|---|---|
| informer `AddFunc` / `UpdateFunc` / `DeleteFunc` | One `ResourceEventHandlerFuncs` is registered per informer, so client-go drives all three from a **single** listener goroutine. The three are serialized against each other. `appInformer`'s handler and `projInformer`'s handler are separate goroutines. |
| `NamespaceIndex` / `orphanedIndex` indexers | Run inside the informer's own `HandleDeltas` loop — a different goroutine from the handlers above. This is why their `setAppCondition` side effect is easy to miss. |
| `handleObjectUpdated` | Invoked from `clusterCache.OnResourceUpdated` in `controller/cache/cache.go:620`, registered **per managed cluster**. Concurrent across clusters. |
| `readinessHealthCheck` | HTTP handler on the metrics server. Any number of concurrent probes, and under dynamic distribution it can re-enqueue every app. |
| `Run` itself | The caller's goroutine. Spawns everything, then blocks on `<-ctx.Done()`. |

### Serialization primitives

Three, and they are the only mutable state shared across workers:

| Primitive | Protects | Held during |
|---|---|---|
| `refreshRequestedAppsMutex` (`sync.Mutex`) | `refreshRequestedApps` map | A map read/write only. Never held across I/O. |
| `projByNameCache` (`sync.Map`) | project cache entries | Lock-free reads. |
| `appProjCache.lock` (`sync.Mutex`, one per project) | that entry's `appProj` | **Held across a `projInformer` + `db` fetch.** Concurrent refresh workers wanting the same project queue behind one fetch rather than stampeding. |
| `kubectlSemaphore` (`semaphore.Weighted`) | fork/exec count | Acquired in `onKubectlRun`, released by the returned cleanup func. Bounds kubectl execs across *all* operation workers at once, default 20. Nil when the limit is < 1, which removes the bound. |

`appProjCache.lock` is the only one held across I/O, so it is the only one that can
show up as latency rather than just contention.
