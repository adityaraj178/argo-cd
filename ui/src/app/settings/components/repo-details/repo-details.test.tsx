import * as React from 'react';
import {render} from '@testing-library/react';
import * as models from '../../../shared/models';
import {RepoDetails} from './repo-details';

let panelProps: any;

jest.mock('../../../shared/components', () => ({
    EditablePanel: (props: any) => {
        panelProps = props;
        return null;
    },
    NumberField: () => null,
    Repo: () => null
}));

jest.mock('argo-ui', () => ({
    FormField: () => null,
    HelpIcon: () => null,
    Text: () => null
}));

const templateCred: models.RepoCreds = {
    url: 'https://charts.example.com',
    type: 'helm',
    username: 'admin',
    enableOCI: true,
    insecureOCIForceHttp: true,
    proxy: 'http://proxy:8080',
    noProxy: 'localhost',
    forceHttpBasicAuth: true,
    useAzureWorkloadIdentity: true
};

describe('RepoDetails', () => {
    beforeEach(() => {
        panelProps = undefined;
    });

    it('keeps credential template settings that are not editable in the form', async () => {
        const save = jest.fn().mockResolvedValue(undefined);
        render(<RepoDetails item={{writeCred: templateCred}} save={save} />);

        await panelProps.save({username: 'new-user', password: 'new-password', bearerToken: '', depth: 0});

        expect(save).toHaveBeenCalledWith(
            expect.objectContaining({
                url: 'https://charts.example.com',
                type: 'helm',
                username: 'new-user',
                password: 'new-password',
                enableOCI: true,
                insecureOCIForceHttp: true,
                proxy: 'http://proxy:8080',
                noProxy: 'localhost',
                forceHttpBasicAuth: true,
                useAzureWorkloadIdentity: true,
                write: true
            })
        );
    });

    it('does not offer saving when readonly', () => {
        render(<RepoDetails item={{readCred: templateCred}} save={jest.fn()} readonly={true} />);

        expect(panelProps.save).toBeUndefined();
    });
});
