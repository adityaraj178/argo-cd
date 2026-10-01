package cache

import (
	"testing"
	"time"

	"github.com/spf13/cobra"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	. "github.com/argoproj/argo-cd/v3/pkg/apis/application/v1alpha1"
	cacheutil "github.com/argoproj/argo-cd/v3/util/cache"
	appstatecache "github.com/argoproj/argo-cd/v3/util/cache/appstate"
)

type fixtures struct {
	*Cache
}

func newFixtures() *fixtures {
	return &fixtures{NewCache(
		appstatecache.NewCache(
			cacheutil.NewCache(cacheutil.NewInMemoryCache(1*time.Hour)),
			1*time.Minute,
		),
		1*time.Minute,
		1*time.Minute,
	)}
}

func TestCache_GetRepoConnectionState(t *testing.T) {
	t.Parallel()
	cache := newFixtures().Cache
	// cache miss
	_, err := cache.GetRepoConnectionState("my-repo", "", false)
	assert.Equal(t, ErrCacheMiss, err)
	// populate cache
	err = cache.SetRepoConnectionState("my-repo", "", false, &ConnectionState{Status: "my-state"})
	require.NoError(t, err)
	// cache miss
	_, err = cache.GetRepoConnectionState("my-repo", "some-project", false)
	assert.Equal(t, ErrCacheMiss, err)
	// populate cache
	err = cache.SetRepoConnectionState("my-repo", "some-project", false, &ConnectionState{Status: "my-project-state"})
	require.NoError(t, err)
	// cache hit
	value, err := cache.GetRepoConnectionState("my-repo", "", false)
	require.NoError(t, err)
	assert.Equal(t, ConnectionState{Status: "my-state"}, value)
	// cache hit
	value, err = cache.GetRepoConnectionState("my-repo", "some-project", false)
	require.NoError(t, err)
	assert.Equal(t, ConnectionState{Status: "my-project-state"}, value)
}

func TestCache_RepoConnectionStateCredentialIsolation(t *testing.T) {
	t.Parallel()
	cache := newFixtures().Cache
	for _, project := range []string{"", "some-project"} {
		for _, write := range []bool{false, true} {
			_, err := cache.GetRepoConnectionState("my-repo", project, write)
			require.ErrorIs(t, err, ErrCacheMiss)
			state := ConnectionState{Status: ConnectionStatusSuccessful, Message: project}
			if write {
				state.Status = ConnectionStatusFailed
			}
			require.NoError(t, cache.SetRepoConnectionState("my-repo", project, write, &state))
		}
	}
	for _, project := range []string{"", "some-project"} {
		readState, err := cache.GetRepoConnectionState("my-repo", project, false)
		require.NoError(t, err)
		assert.Equal(t, ConnectionState{Status: ConnectionStatusSuccessful, Message: project}, readState)
		writeState, err := cache.GetRepoConnectionState("my-repo", project, true)
		require.NoError(t, err)
		assert.Equal(t, ConnectionState{Status: ConnectionStatusFailed, Message: project}, writeState)

		require.NoError(t, cache.SetRepoConnectionState("my-repo", project, false, nil))
		_, err = cache.GetRepoConnectionState("my-repo", project, false)
		require.ErrorIs(t, err, ErrCacheMiss)
		remaining, err := cache.GetRepoConnectionState("my-repo", project, true)
		require.NoError(t, err)
		assert.Equal(t, writeState, remaining)

		require.NoError(t, cache.SetRepoConnectionState("my-repo", project, false, &readState))
		require.NoError(t, cache.SetRepoConnectionState("my-repo", project, true, nil))
		_, err = cache.GetRepoConnectionState("my-repo", project, true)
		require.ErrorIs(t, err, ErrCacheMiss)
		remaining, err = cache.GetRepoConnectionState("my-repo", project, false)
		require.NoError(t, err)
		assert.Equal(t, readState, remaining)
	}
}

func TestAddCacheFlagsToCmd(t *testing.T) {
	t.Parallel()
	cache, err := AddCacheFlagsToCmd(&cobra.Command{})()
	require.NoError(t, err)
	assert.Equal(t, 1*time.Hour, cache.connectionStatusCacheExpiration)
	assert.Equal(t, 3*time.Minute, cache.oidcCacheExpiration)
}
