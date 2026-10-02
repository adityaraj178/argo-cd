package webhook

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	"github.com/argoproj/argo-cd/v3/pkg/apis/application/v1alpha1"
	"github.com/argoproj/argo-cd/v3/util/db/mocks"
	"github.com/argoproj/argo-cd/v3/util/settings"
)

// TestBitbucketCloudCallbackCredentialReproduction is a local diagnostic, not
// a regression test for a fix: PASS in the positive cases confirms disclosure
// of synthetic credentials to the loopback receiver. No real secrets are used.
func TestBitbucketCloudCallbackCredentialReproduction(t *testing.T) {
	const hookUUID = "{11111111-2222-4333-8444-555555555555}"
	const repoURL = "https://bitbucket.org/local-security-test/demo.git"
	const dummyPassword = "LOCAL-TEST-ONLY-PASSWORD"
	const dummyToken = "LOCAL-TEST-ONLY-TOKEN"

	tests := []struct {
		name           string
		configuredUUID string
		requestUUID    string
		bearer         bool
		wantCallback   bool
		wantStatus     int
	}{
		{"matching_uuid_basic_auth", hookUUID, hookUUID, false, true, http.StatusOK},
		{"matching_uuid_bearer_auth", hookUUID, hookUUID, true, true, http.StatusOK},
		{"wrong_uuid_rejected", hookUUID, "wrong-uuid", false, false, http.StatusBadRequest},
		{"uuid_not_configured_no_callback", "", hookUUID, false, false, http.StatusOK},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var receivedAuth []string
			var receivedPaths []string
			receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				receivedAuth = append(receivedAuth, r.Header.Get("Authorization"))
				receivedPaths = append(receivedPaths, r.URL.Path)
				mu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				if strings.Contains(r.URL.Path, "/diffstat/") {
					_, _ = w.Write([]byte(`{"values":[],"pagelen":100,"size":0}`))
					return
				}
				_, _ = w.Write([]byte(`{"mainbranch":{"name":"main"}}`))
			}))
			t.Cleanup(receiver.Close)

			repo := &v1alpha1.Repository{Repo: repoURL, Username: "local-test-user", Password: dummyPassword}
			wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("local-test-user:"+dummyPassword))
			if tc.bearer {
				repo.Username, repo.Password = "", ""
				repo.BearerToken = dummyToken
				wantAuth = "Bearer " + dummyToken
			}
			mockDB := &mocks.ArgoDB{}
			if tc.wantStatus == http.StatusOK {
				// Accepted events also look up the repo during normal refresh
				// processing, independently of the authenticated API callback.
				calls := 1
				if tc.wantCallback {
					calls++
				}
				mockDB.EXPECT().ListRepositories(mock.Anything).Return([]*v1alpha1.Repository{repo}, nil).Times(calls)
			}
			h := newMockHandler(nil, nil, 1024*1024, mockDB, &settings.ArgoCDSettings{WebhookBitbucketUUID: tc.configuredUUID})
			var shutdown sync.Once
			stop := func() { shutdown.Do(h.Shutdown) }
			t.Cleanup(stop)

			// The lookup URL identifies the synthetic repository, while the
			// independent API URL points exclusively to our loopback receiver.
			payload := fmt.Sprintf(`{
				"push":{"changes":[{"new":{"name":"main","target":{"hash":"bbbbbbb"}},"old":{"target":{"hash":"aaaaaaa"}}}]},
				"repository":{"name":"demo","full_name":"local-security-test/demo","links":{
					"html":{"href":"https://bitbucket.org/local-security-test/demo"},
					"self":{"href":"%s/2.0/repositories/local-security-test/demo"}
				}}
			}`, receiver.URL)
			req := httptest.NewRequest(http.MethodPost, "/api/webhook", strings.NewReader(payload))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Event-Key", "repo:push")
			req.Header.Set("X-Hook-UUID", tc.requestUUID)
			response := httptest.NewRecorder()
			h.Handler(response, req)
			stop() // Drain the queue before checking the receiver; no arbitrary sleeps.

			require.Equal(t, tc.wantStatus, response.Code, response.Body.String())
			mockDB.AssertExpectations(t)
			mu.Lock()
			defer mu.Unlock()
			if !tc.wantCallback {
				require.Empty(t, receivedAuth, "control must not send a callback")
				t.Log("CONTROL: no outbound callback received")
				return
			}
			require.NotEmpty(t, receivedAuth, "expected a callback to the loopback receiver")
			for i, auth := range receivedAuth {
				require.Equal(t, wantAuth, auth, "callback %s", receivedPaths[i])
				t.Logf("REPRODUCED: loopback receiver got synthetic Authorization on %s", receivedPaths[i])
			}
		})
	}
}
