import * as models from '../../../shared/models';
import {isRepoUpdatable} from './repos-filter';

const repo = (overrides: Partial<models.Repository>): models.Repository => ({
    repo: 'https://github.com/argoproj/argocd-example-apps',
    type: 'git',
    connectionState: {status: 'Successful', message: '', attemptedAt: null},
    enableOCI: false,
    useAzureWorkloadIdentity: false,
    ...overrides
});

const cred = (overrides: Partial<models.RepoCreds>): models.RepoCreds => ({
    url: 'https://github.com/argoproj',
    type: 'git',
    username: 'admin',
    ...overrides
});

describe('isRepoUpdatable', () => {
    describe('repositories', () => {
        it('allows HTTPS git and helm repositories', () => {
            expect(isRepoUpdatable({readRepo: repo({})})).toBe(true);
            expect(isRepoUpdatable({writeRepo: repo({})})).toBe(true);
            expect(isRepoUpdatable({readRepo: repo({type: 'helm', repo: 'https://charts.example.com'})})).toBe(true);
        });

        it('allows Helm OCI repositories without a URL scheme', () => {
            expect(isRepoUpdatable({readRepo: repo({type: 'helm', enableOCI: true, repo: 'registry.example.com/charts'})})).toBe(true);
        });

        it('rejects OCI-enabled repositories that are not Helm', () => {
            expect(isRepoUpdatable({readRepo: repo({type: 'git', enableOCI: true})})).toBe(false);
        });

        it('rejects SSH repositories', () => {
            expect(isRepoUpdatable({readRepo: repo({repo: 'git@github.com:argoproj/argocd-example-apps.git'})})).toBe(false);
        });

        it('rejects GitHub App and Azure Service Principal repositories', () => {
            expect(isRepoUpdatable({readRepo: repo({githubAppID: '123'})})).toBe(false);
            expect(isRepoUpdatable({readRepo: repo({azureServicePrincipalClientId: 'client-id'})})).toBe(false);
        });

        it('rejects oci type repositories', () => {
            expect(isRepoUpdatable({readRepo: repo({type: 'oci', repo: 'oci://registry.example.com/charts'})})).toBe(false);
        });
    });

    describe('credential templates', () => {
        it('allows HTTPS username/password git and helm templates', () => {
            expect(isRepoUpdatable({readCred: cred({})})).toBe(true);
            expect(isRepoUpdatable({writeCred: cred({})})).toBe(true);
            expect(isRepoUpdatable({readCred: cred({type: 'helm', url: 'https://charts.example.com'})})).toBe(true);
        });

        it('allows Helm OCI templates', () => {
            expect(isRepoUpdatable({readCred: cred({type: 'helm', enableOCI: true, url: 'registry.example.com'})})).toBe(true);
        });

        it('rejects SSH templates', () => {
            expect(isRepoUpdatable({readCred: cred({url: 'git@github.com:argoproj'})})).toBe(false);
        });

        it('rejects GitHub App and Azure Service Principal templates', () => {
            expect(isRepoUpdatable({readCred: cred({githubAppID: '123'})})).toBe(false);
            expect(isRepoUpdatable({readCred: cred({azureServicePrincipalClientId: 'client-id'})})).toBe(false);
        });

        it('rejects templates without a username, such as GCP or bearer-token templates', () => {
            expect(isRepoUpdatable({readCred: cred({username: undefined, url: 'https://source.developers.google.com/p/project'})})).toBe(false);
            expect(isRepoUpdatable({readCred: cred({username: ''})})).toBe(false);
        });

        it('rejects OCI-enabled templates that are not Helm', () => {
            expect(isRepoUpdatable({readCred: cred({type: 'git', enableOCI: true})})).toBe(false);
        });
    });

    it('rejects empty items', () => {
        expect(isRepoUpdatable({})).toBe(false);
    });
});
