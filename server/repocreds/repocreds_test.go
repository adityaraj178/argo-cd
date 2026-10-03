package repocreds

import (
	"testing"

	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/argoproj/argo-cd/v3/common"
	repocredspkg "github.com/argoproj/argo-cd/v3/pkg/apiclient/repocreds"
	appsv1 "github.com/argoproj/argo-cd/v3/pkg/apis/application/v1alpha1"
	"github.com/argoproj/argo-cd/v3/util/assets"
	dbmocks "github.com/argoproj/argo-cd/v3/util/db/mocks"
	"github.com/argoproj/argo-cd/v3/util/rbac"
)

func TestListWriteRepositoryCredentials(t *testing.T) {
	enforcer := rbac.NewEnforcer(fake.NewSimpleClientset(), "default", common.ArgoCDRBACConfigMapName, nil)
	require.NoError(t, enforcer.SetBuiltinPolicy(assets.BuiltinPolicyCSV))
	enforcer.SetDefaultRole("role:admin")
	enforcer.SetClaimsEnforcerFunc(func(_ jwt.Claims, _ ...any) bool { return true })

	const sshURL = "git@github.com:org"
	argoDB := &dbmocks.ArgoDB{}
	argoDB.EXPECT().ListWriteRepositoryCredentials(mock.Anything).Return([]string{sshURL}, nil)
	argoDB.EXPECT().GetWriteRepositoryCredentials(mock.Anything, sshURL).Return(&appsv1.RepoCreds{URL: sshURL, SSHPrivateKey: "key"}, nil)

	list, err := NewServer(argoDB, enforcer).ListWriteRepositoryCredentials(t.Context(), &repocredspkg.RepoCredsQuery{})
	require.NoError(t, err)
	require.Len(t, list.Items, 1)
	assert.Equal(t, sshURL, list.Items[0].URL)
	argoDB.AssertNotCalled(t, "ListRepositoryCredentials", mock.Anything)
}
