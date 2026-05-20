package application

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/tools/cache"

	"github.com/argoproj/argo-cd/v3/pkg/apis/application/v1alpha1"
	"github.com/argoproj/argo-cd/v3/util/rbac"
)

// FilterOptions contains the distinct values available for each filter dimension.
// These are derived from the informer indexes and RBAC-filtered applications.
type FilterOptions struct {
	Namespaces      []string            `json:"namespaces"`
	Clusters        []string            `json:"clusters"`
	Repos           []string            `json:"repos"`
	TargetRevisions []string            `json:"targetRevisions"`
	Labels          map[string][]string `json:"labels"`
	Annotations     map[string][]string `json:"annotations"`
}

// ListFilterOptions returns the distinct filter values from the informer indexes,
// filtered by RBAC so users only see values for applications they have access to.
func (s *Server) ListFilterOptions(claims any) (*FilterOptions, error) {
	indexer := s.appInformer.GetIndexer()

	// Get all RBAC-permitted apps first
	apps, err := s.appLister.List(labels.Everything())
	if err != nil {
		return nil, err
	}

	// Build set of permitted app keys
	permittedApps := make(map[string]*v1alpha1.Application, len(apps))
	for _, a := range apps {
		if !s.isNamespaceEnabled(a.Namespace) {
			continue
		}
		if s.enf.Enforce(claims, rbac.ResourceApplications, rbac.ActionGet, a.RBACName(s.ns)) {
			permittedApps[a.Namespace+"/"+a.Name] = a
		}
	}

	// Extract distinct values from indexes, filtered by permitted apps
	namespaces := getPermittedIndexKeys(indexer, IndexByNamespace, permittedApps)
	clusters := getPermittedIndexKeys(indexer, IndexByCluster, permittedApps)
	repos := getPermittedIndexKeys(indexer, IndexByRepo, permittedApps)
	targetRevisions := getPermittedIndexKeys(indexer, IndexByTargetRevision, permittedApps)

	// Extract labels and annotations from indexes, filtered by permitted apps
	labelKeys := getPermittedIndexKeys(indexer, IndexByLabel, permittedApps)
	labelsMap := indexKeysToMap(labelKeys)

	annotationKeys := getPermittedIndexKeys(indexer, IndexByAnnotation, permittedApps)
	annotationsMap := indexKeysToMap(annotationKeys)

	// Convert to sorted slices
	labelsSorted := mapOfSlicesToSortedMap(labelsMap)
	annotationsSorted := mapOfSlicesToSortedMap(annotationsMap)

	sort.Strings(namespaces)
	sort.Strings(clusters)
	sort.Strings(repos)
	sort.Strings(targetRevisions)

	return &FilterOptions{
		Namespaces:      namespaces,
		Clusters:        clusters,
		Repos:           repos,
		TargetRevisions: targetRevisions,
		Labels:          labelsSorted,
		Annotations:     annotationsSorted,
	}, nil
}

// getPermittedIndexKeys returns the index keys that have at least one permitted app.
func getPermittedIndexKeys(indexer cache.Indexer, indexName string, permittedApps map[string]*v1alpha1.Application) []string {
	keys, err := indexer.IndexKeys(indexName, "")
	if err != nil {
		// IndexKeys with empty value won't work; list all keys from the index
		keys = listAllIndexKeys(indexer, indexName)
	}
	if len(keys) == 0 {
		keys = listAllIndexKeys(indexer, indexName)
	}

	var result []string
	seen := make(map[string]bool)
	for _, key := range keys {
		items, err := indexer.ByIndex(indexName, key)
		if err != nil {
			continue
		}
		for _, item := range items {
			if app, ok := item.(*v1alpha1.Application); ok {
				appKey := app.Namespace + "/" + app.Name
				if permittedApps[appKey] != nil && !seen[key] {
					seen[key] = true
					result = append(result, key)
					break
				}
			}
		}
	}
	return result
}

// listAllIndexKeys retrieves all distinct keys for an index by scanning all objects.
func listAllIndexKeys(indexer cache.Indexer, indexName string) []string {
	keySet := make(map[string]bool)
	for _, obj := range indexer.List() {
		if app, ok := obj.(*v1alpha1.Application); ok {
			var indexKeys []string
			switch indexName {
			case IndexByNamespace:
				indexKeys, _ = indexByNamespace(app)
			case IndexByCluster:
				indexKeys, _ = indexByCluster(app)
			case IndexByRepo:
				indexKeys, _ = indexByRepo(app)
			case IndexByTargetRevision:
				indexKeys, _ = indexByTargetRevision(app)
			case IndexByLabel:
				indexKeys, _ = indexByLabel(app)
			case IndexByAnnotation:
				indexKeys, _ = indexByAnnotation(app)
			}
			for _, k := range indexKeys {
				keySet[k] = true
			}
		}
	}
	result := make([]string, 0, len(keySet))
	for k := range keySet {
		result = append(result, k)
	}
	return result
}

// indexKeysToMap converts index keys like "key=value" into a map[key]Set(values).
func indexKeysToMap(keys []string) map[string]map[string]bool {
	result := make(map[string]map[string]bool)
	for _, kv := range keys {
		if kv == "" {
			continue
		}
		parts := strings.SplitN(kv, "=", 2)
		if len(parts) != 2 {
			continue
		}
		k, v := parts[0], parts[1]
		if result[k] == nil {
			result[k] = make(map[string]bool)
		}
		result[k][v] = true
	}
	return result
}

// mapOfSlicesToSortedMap converts map[key]Set(values) to map[key][]sortedValues.
func mapOfSlicesToSortedMap(m map[string]map[string]bool) map[string][]string {
	result := make(map[string][]string, len(m))
	for k, vals := range m {
		sorted := make([]string, 0, len(vals))
		for v := range vals {
			sorted = append(sorted, v)
		}
		sort.Strings(sorted)
		result[k] = sorted
	}
	return result
}

// FilterOptionsHandler returns an HTTP handler for the /api/v1/applications/filter-options endpoint.
// It expects to be wrapped with session.WithAuthMiddleware which sets "claims" in the request context.
func (s *Server) FilterOptionsHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims := r.Context().Value("claims")

		opts, err := s.ListFilterOptions(claims)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(opts); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
	})
}
