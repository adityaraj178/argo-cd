package application

import (
	"errors"
	"fmt"
	"strings"

	"k8s.io/client-go/tools/cache"

	"github.com/argoproj/argo-cd/v3/pkg/apis/application/v1alpha1"
)

const (
	IndexByProject        = "byProject"
	IndexBySyncStatus     = "bySyncStatus"
	IndexByHealthStatus   = "byHealthStatus"
	IndexByCluster        = "byCluster"
	IndexByNamespace      = "byNamespace"
	IndexByRepo           = "byRepo"
	IndexByAutoSync       = "byAutoSync"
	IndexByTargetRevision = "byTargetRevision"
	IndexByOperation      = "byOperation"
	IndexByLabel          = "byLabel"
	IndexByAnnotation     = "byAnnotation"
)

func AppIndexers() cache.Indexers {
	return cache.Indexers{
		IndexByProject:        indexByProject,
		IndexBySyncStatus:     indexBySyncStatus,
		IndexByHealthStatus:   indexByHealthStatus,
		IndexByCluster:        indexByCluster,
		IndexByNamespace:      indexByNamespace,
		IndexByRepo:           indexByRepo,
		IndexByAutoSync:       indexByAutoSync,
		IndexByTargetRevision: indexByTargetRevision,
		IndexByOperation:      indexByOperation,
		IndexByLabel:          indexByLabel,
		IndexByAnnotation:     indexByAnnotation,
	}
}

func indexByProject(obj any) ([]string, error) {
	app, ok := obj.(*v1alpha1.Application)
	if !ok {
		return nil, errors.New("object is not an Application")
	}
	project := app.Spec.GetProject()
	if project == "" {
		project = "default"
	}
	return []string{project}, nil
}

func indexBySyncStatus(obj any) ([]string, error) {
	app, ok := obj.(*v1alpha1.Application)
	if !ok {
		return nil, errors.New("object is not an Application")
	}
	status := string(app.Status.Sync.Status)
	if status == "" {
		status = "Unknown"
	}
	return []string{status}, nil
}

func indexByHealthStatus(obj any) ([]string, error) {
	app, ok := obj.(*v1alpha1.Application)
	if !ok {
		return nil, errors.New("object is not an Application")
	}
	status := string(app.Status.Health.Status)
	if status == "" {
		status = "Unknown"
	}
	return []string{status}, nil
}

func indexByCluster(obj any) ([]string, error) {
	app, ok := obj.(*v1alpha1.Application)
	if !ok {
		return nil, errors.New("object is not an Application")
	}
	var keys []string
	if app.Spec.Destination.Server != "" {
		keys = append(keys, app.Spec.Destination.Server)
	}
	if app.Spec.Destination.Name != "" {
		keys = append(keys, app.Spec.Destination.Name)
	}
	if len(keys) == 0 {
		keys = append(keys, "")
	}
	return keys, nil
}

func indexByNamespace(obj any) ([]string, error) {
	app, ok := obj.(*v1alpha1.Application)
	if !ok {
		return nil, errors.New("object is not an Application")
	}
	ns := app.Spec.Destination.Namespace
	if ns == "" {
		ns = ""
	}
	return []string{ns}, nil
}

func indexByRepo(obj any) ([]string, error) {
	app, ok := obj.(*v1alpha1.Application)
	if !ok {
		return nil, errors.New("object is not an Application")
	}
	var repos []string
	if app.Spec.HasMultipleSources() {
		for _, src := range app.Spec.Sources {
			if src.RepoURL != "" {
				repos = append(repos, src.RepoURL)
			}
		}
	} else if src := app.Spec.GetSource(); src.RepoURL != "" {
		repos = append(repos, src.RepoURL)
	}
	if len(repos) == 0 {
		repos = append(repos, "")
	}
	return repos, nil
}

func indexByAutoSync(obj any) ([]string, error) {
	app, ok := obj.(*v1alpha1.Application)
	if !ok {
		return nil, errors.New("object is not an Application")
	}
	if app.Spec.SyncPolicy != nil && app.Spec.SyncPolicy.Automated != nil &&
		(app.Spec.SyncPolicy.Automated.Enabled == nil || *app.Spec.SyncPolicy.Automated.Enabled) {
		return []string{"Enabled"}, nil
	}
	return []string{"Disabled"}, nil
}

func indexByTargetRevision(obj any) ([]string, error) {
	app, ok := obj.(*v1alpha1.Application)
	if !ok {
		return nil, errors.New("object is not an Application")
	}
	var revisions []string
	if app.Spec.HasMultipleSources() {
		for _, src := range app.Spec.Sources {
			if src.TargetRevision != "" {
				revisions = append(revisions, src.TargetRevision)
			}
		}
	} else if src := app.Spec.GetSource(); src.TargetRevision != "" {
		revisions = append(revisions, src.TargetRevision)
	}
	if len(revisions) == 0 {
		revisions = append(revisions, "")
	}
	return revisions, nil
}

func indexByOperation(obj any) ([]string, error) {
	app, ok := obj.(*v1alpha1.Application)
	if !ok {
		return nil, errors.New("object is not an Application")
	}
	return []string{getAppOperationState(app)}, nil
}

// getAppOperationState derives the operation state title for an application,
// matching the UI logic in getOperationStateTitle.
func getAppOperationState(app *v1alpha1.Application) string {
	if app.Status.OperationState == nil {
		return "Unknown"
	}
	if app.DeletionTimestamp != nil {
		return "Deleting"
	}
	switch app.Status.OperationState.Phase {
	case "Running":
		return "Syncing"
	case "Error":
		return "Sync error"
	case "Failed":
		return "Sync failed"
	case "Succeeded":
		return "Sync OK"
	case "Terminating":
		return "Terminated"
	default:
		return "Unknown"
	}
}

func indexByLabel(obj any) ([]string, error) {
	app, ok := obj.(*v1alpha1.Application)
	if !ok {
		return nil, errors.New("object is not an Application")
	}
	var keys []string
	for k, v := range app.Labels {
		keys = append(keys, k+"="+v)
	}
	if len(keys) == 0 {
		keys = append(keys, "")
	}
	return keys, nil
}

func indexByAnnotation(obj any) ([]string, error) {
	app, ok := obj.(*v1alpha1.Application)
	if !ok {
		return nil, errors.New("object is not an Application")
	}
	var keys []string
	for k, v := range app.Annotations {
		if strings.Contains(k, "argoproj.io") || strings.Contains(k, "kubernetes.io") {
			continue
		}
		keys = append(keys, k+"="+v)
	}
	if len(keys) == 0 {
		keys = append(keys, "")
	}
	return keys, nil
}

// intersectAppSets computes the intersection of multiple sets of application keys.
// Each set is represented as map[string]bool where the key is "namespace/name".
// If no sets are provided, returns nil (meaning no filtering).
func intersectAppSets(sets []map[string]bool) map[string]bool {
	if len(sets) == 0 {
		return nil
	}
	if len(sets) == 1 {
		return sets[0]
	}

	// Start with the smallest set for efficiency
	smallest := 0
	for i, s := range sets {
		if len(s) < len(sets[smallest]) {
			smallest = i
		}
	}

	result := make(map[string]bool)
	for key := range sets[smallest] {
		inAll := true
		for i, s := range sets {
			if i == smallest {
				continue
			}
			if !s[key] {
				inAll = false
				break
			}
		}
		if inAll {
			result[key] = true
		}
	}
	return result
}

// getAppKeysFromIndex queries the indexer for all given filter values and returns
// the union of matching app keys (namespace/name) as a set.
func getAppKeysFromIndex(indexer cache.Indexer, indexName string, filterValues []string) (map[string]bool, error) {
	result := make(map[string]bool)
	for _, val := range filterValues {
		items, err := indexer.ByIndex(indexName, val)
		if err != nil {
			return nil, fmt.Errorf("error querying index %s for value %s: %w", indexName, val, err)
		}
		for _, item := range items {
			if app, ok := item.(*v1alpha1.Application); ok {
				key := app.Namespace + "/" + app.Name
				result[key] = true
			}
		}
	}
	return result, nil
}
