# 6. Sequence — one full reconcile across both loops

```mermaid
sequenceDiagram
    autonumber
    participant INF as appInformer
    participant RQ as appRefreshQueue
    participant RW as RefreshWorker<br/>processAppRefreshQueueItem
    participant ASM as AppStateManager
    participant API as K8s API Server
    participant OQ as appOperationQueue
    participant OW as OperationWorker<br/>processAppOperationQueueItem

    INF->>RQ: UpdateFunc → requestAppRefresh → AddRateLimited(key)
    RW->>RQ: Get()
    RW->>RW: needRefreshAppStatus()
    alt no refresh needed
        RW-->>OQ: defer AddRateLimited(key)
    else refresh needed
        RW->>RW: refreshAppConditions() → getAppProj()
        RW->>ASM: CompareAppState(app, proj, revisions, sources)
        ASM-->>RW: comparisonResult
        RW->>RW: normalizeApplication() → PatchAppWithWriteBack()
        RW->>RW: setAppManagedResources() → hideSecretData + getResourceTree
        RW->>RW: autoSync(syncStatus, resources)
        alt auto-sync proceeds
            RW->>API: argo.SetAppOperation() writes .operation
            RW->>INF: writeBackToInformer(updatedApp)
        end
        RW->>API: persistAppStatus() → PatchAppWithWriteBack()
        RW-->>OQ: defer AddRateLimited(key)
    end

    OW->>OQ: Get()
    OW->>API: Get fresh app (informer may be stale)
    alt .operation != nil
        OW->>OW: processRequestedAppOperation()
        OW->>API: setOperationState() → PatchAppWithWriteBack()
        OW->>ASM: SyncAppState(app, proj, state)
        ASM-->>OW: state.Phase updated
        OW->>API: setOperationState() final
        OW->>RQ: requestAppRefresh() if phase completed
    else deletionTimestamp != nil
        OW->>OW: finalizeApplicationDeletion()
        OW->>API: delete live objects, patch finalizers
    end
```

## The one thing to internalize

The controller never syncs directly. The refresh loop only ever **writes
`.operation` to the Application**; the operation loop picks that up later. A user
clicking Sync in the UI and `autoSync` deciding to sync converge on the same code
path from that point forward, which is why retries, timeouts, and termination behave
identically for both.

## Why the loops are split

Syncing is slow (manifest generation, kubectl apply, hook waits). If a single worker
handled both, a long sync would starve status reporting for every other app on the
shard. The chaining in the refresh loop's `defer` is deliberate and documented in
the source as a fix for
[argo-cd#18500](https://github.com/argoproj/argo-cd/issues/18500):

```go
defer func() {
    // We want to have app operation update happen after the sync, so there's no race
    // condition and app updates not proceeding.
    ctrl.appOperationQueue.AddRateLimited(appKey)
    ctrl.appRefreshQueue.Done(appKey)
}()
```

Note it runs unconditionally — even when `needRefreshAppStatus` returned false — so a
pending operation is never missed just because the status was already fresh.
