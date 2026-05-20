import {Autocomplete, ErrorNotification, MockupList, NotificationType, SlidingPanel, Toolbar, Tooltip} from 'argo-ui';
import * as classNames from 'classnames';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import {Key, KeybindingContext, KeybindingProvider} from 'argo-ui/v2';
import {RouteComponentProps} from 'react-router';
import {combineLatest, from, merge, Observable} from 'rxjs';
import {bufferTime, delay, filter, map, mergeMap, repeat, retryWhen} from 'rxjs/operators';
import {AddAuthToToolbar, ClusterCtx, DataLoader, EmptyState, Page, Paginate, Spinner} from '../../../shared/components';
import {AuthSettingsCtx, Consumer, Context, ContextApis} from '../../../shared/context';
import * as models from '../../../shared/models';
import {AppsListViewKey, AppsListPreferences, AppsListViewType, HealthStatusBarPreferences, services} from '../../../shared/services';
import {ApplicationCreatePanel} from '../application-create-panel/application-create-panel';
import {ApplicationSyncPanel} from '../application-sync-panel/application-sync-panel';
import {ApplicationsSyncPanel} from '../applications-sync-panel/applications-sync-panel';
import * as AppUtils from '../utils';
import {ApplicationsFilter, FilteredApp, getAppFilterResults} from './applications-filter';
import {AppsStatusBar} from './applications-status-bar';
import {ApplicationsSummary} from './applications-summary';
import {ApplicationsTable} from './applications-table';
import {ApplicationTiles} from './applications-tiles';
import {ApplicationsRefreshPanel} from '../applications-refresh-panel/applications-refresh-panel';
import {useSidebarTarget} from '../../../sidebar/sidebar';
import {useQuery, useObservableQuery} from '../../../shared/hooks/query';
import ReactPaginate from 'react-paginate';

import './applications-list.scss';
import './flex-top-bar.scss';
import '../../../shared/components/paginate/paginate.scss';

const DEFAULT_SERVER_PAGE_SIZE = 200;
const EVENTS_BUFFER_TIMEOUT = 500;
const WATCH_RETRY_TIMEOUT = 500;

// The applications list/watch API supports only selected set of fields.
// Make sure to register any new fields in the `appFields` map of `pkg/apiclient/application/forwarder_overwrite.go`.
const APP_FIELDS = [
    'metadata.name',
    'metadata.namespace',
    'metadata.annotations',
    'metadata.labels',
    'metadata.creationTimestamp',
    'metadata.deletionTimestamp',
    'spec',
    'operation.sync',
    'status.sourceHydrator',
    'status.sync.status',
    'status.sync.revision',
    'status.health',
    'status.operationState.phase',
    'status.operationState.finishedAt',
    'status.operationState.operation.sync',
    'status.summary',
    'status.resources'
];
const APP_LIST_FIELDS = ['metadata.resourceVersion', ...APP_FIELDS.map(field => `items.${field}`)];
const APP_WATCH_FIELDS = ['result.type', ...APP_FIELDS.map(field => `result.application.${field}`)];

interface ServerFilterParams {
    projects: string[];
    appNamespace: string;
    syncStatuses: string[];
    healthStatuses: string[];
    clusters: string[];
    namespaces: string[];
    autoSyncStatuses: string[];
    repos: string[];
    targetRevisions: string[];
    operations: string[];
    search: string;
    sortBy: string;
    sortOrder: string;
    offset: number;
    limit: number;
    selector: string;
    annotationsFilter: string[];
}

interface LoadResult {
    applications: models.Application[];
    totalCount: number;
}

function buildFilterInputKey(params: ServerFilterParams): string {
    return JSON.stringify({
        p: params.projects,
        ns: params.appNamespace,
        ss: params.syncStatuses,
        hs: params.healthStatuses,
        cl: params.clusters,
        dns: params.namespaces,
        as: params.autoSyncStatuses,
        r: params.repos,
        tr: params.targetRevisions,
        op: params.operations,
        q: params.search,
        sb: params.sortBy,
        so: params.sortOrder,
        o: params.offset,
        l: params.limit,
        sel: params.selector,
        ann: params.annotationsFilter
    });
}

function loadApplications(params: ServerFilterParams): Observable<LoadResult> {
    return from(
        services.applications.list(params.projects, 'application', {
            appNamespace: params.appNamespace,
            fields: APP_LIST_FIELDS,
            selector: params.selector || undefined,
            syncStatuses: params.syncStatuses,
            healthStatuses: params.healthStatuses,
            clusters: params.clusters,
            namespaces: params.namespaces,
            autoSyncStatuses: params.autoSyncStatuses,
            repos: params.repos,
            targetRevisions: params.targetRevisions,
            operations: params.operations,
            annotations: params.annotationsFilter.length > 0 ? params.annotationsFilter : undefined,
            search: params.search || undefined,
            sortBy: params.sortBy || undefined,
            sortOrder: params.sortOrder || undefined,
            limit: params.limit != null ? params.limit : DEFAULT_SERVER_PAGE_SIZE,
            offset: params.offset || 0
        })
    ).pipe(
        map(applicationsList => {
            const applications = (applicationsList.items || []) as models.Application[];
            const remaining = (applicationsList.metadata as any)?.remainingItemCount || 0;
            const totalCount = applications.length + (params.offset || 0) + remaining;
            return {applications, totalCount};
        })
    );
}

function loadAllApplications(projects: string[], appNamespace: string): Observable<models.Application[]> {
    return from(services.applications.list(projects, 'application', {appNamespace, fields: APP_LIST_FIELDS})).pipe(
        mergeMap(applicationsList => {
            const applications = applicationsList.items as models.Application[];
            return merge(
                from([applications]),
                services.applications
                    .watch('application', {projects, resourceVersion: applicationsList.metadata.resourceVersion}, {fields: APP_WATCH_FIELDS})
                    .pipe(repeat())
                    .pipe(retryWhen(errors => errors.pipe(delay(WATCH_RETRY_TIMEOUT))))
                    .pipe(bufferTime(EVENTS_BUFFER_TIMEOUT))
                    .pipe(
                        map(appChanges => {
                            appChanges.forEach(appChange => {
                                const index = applications.findIndex(item => AppUtils.appInstanceName(item) === AppUtils.appInstanceName(appChange.application));
                                switch (appChange.type) {
                                    case 'DELETED':
                                        if (index > -1) {
                                            applications.splice(index, 1);
                                        }
                                        break;
                                    default:
                                        if (index > -1) {
                                            applications[index] = appChange.application;
                                        } else {
                                            applications.unshift(appChange.application);
                                        }
                                        break;
                                }
                            });
                            return {applications, updated: appChanges.length > 0};
                        })
                    )
                    .pipe(filter(item => item.updated))
                    .pipe(map(item => item.applications))
            );
        })
    );
}

function filterApplications(applications: models.Application[], pref: AppsListPreferences, search: string): {filteredApps: models.Application[]; filterResults: FilteredApp[]} {
    const apps = applications || [];
    const processedApps = apps.map(app => {
        let isAppOfAppsPattern = false;
        if (app.status?.resources) {
            for (const resource of app.status.resources) {
                if (resource.kind === 'Application') {
                    isAppOfAppsPattern = true;
                    break;
                }
            }
        }
        return {...app, isAppOfAppsPattern};
    });
    const filterResults = getAppFilterResults(processedApps, pref);

    return {
        filterResults,
        filteredApps: filterResults.filter(
            app => (search === '' || app.metadata.name.includes(search) || app.metadata.namespace.includes(search)) && Object.values(app.filterResult).every(val => val)
        )
    };
}

const ViewPref = ({children}: {children: (pref: AppsListPreferences & {page: number; search: string}) => React.ReactNode}) => {
    const observableQuery$ = useObservableQuery();

    return (
        <DataLoader
            load={() =>
                combineLatest([services.viewPreferences.getPreferences().pipe(map(item => item.appList)), observableQuery$]).pipe(
                    map(items => {
                        const params = items[1];
                        const viewPref: AppsListPreferences = {...items[0]};
                        if (params.get('proj') != null) {
                            viewPref.projectsFilter = params
                                .get('proj')
                                .split(',')
                                .filter(item => !!item);
                        }
                        if (params.get('sync') != null) {
                            viewPref.syncFilter = params
                                .get('sync')
                                .split(',')
                                .filter(item => !!item);
                        }
                        if (params.get('autoSync') != null) {
                            viewPref.autoSyncFilter = params
                                .get('autoSync')
                                .split(',')
                                .filter(item => !!item);
                        }
                        if (params.get('operation') != null) {
                            viewPref.operationFilter = params
                                .get('operation')
                                .split(',')
                                .filter(item => !!item);
                        }
                        if (params.get('health') != null) {
                            viewPref.healthFilter = params
                                .get('health')
                                .split(',')
                                .filter(item => !!item);
                        }
                        if (params.get('namespace') != null) {
                            viewPref.namespacesFilter = params
                                .get('namespace')
                                .split(',')
                                .filter(item => !!item);
                        }
                        if (params.get('targetRevision') != null) {
                            viewPref.targetRevisionFilter = params
                                .get('targetRevision')
                                .split(',')
                                .map(decodeURIComponent)
                                .filter(item => !!item);
                        }
                        if (params.get('cluster') != null) {
                            viewPref.clustersFilter = params
                                .get('cluster')
                                .split(',')
                                .filter(item => !!item);
                        }
                        if (params.get('showFavorites') != null) {
                            viewPref.showFavorites = params.get('showFavorites') === 'true';
                        }
                        if (params.get('view') != null) {
                            viewPref.view = params.get('view') as AppsListViewType;
                        }
                        if (params.get('labels') != null) {
                            viewPref.labelsFilter = params
                                .get('labels')
                                .split(',')
                                .map(decodeURIComponent)
                                .filter(item => !!item);
                        }
                        if (params.get('annotations') != null) {
                            viewPref.annotationsFilter = params
                                .get('annotations')
                                .split(',')
                                .map(decodeURIComponent)
                                .filter(item => !!item);
                        }
                        if (params.get('repo') != null) {
                            viewPref.reposFilter = params
                                .get('repo')
                                .split(',')
                                .map(decodeURIComponent)
                                .filter(item => !!item);
                        }
                        if (params.get('sortBy') != null) {
                            viewPref.sortBy = params.get('sortBy');
                        }
                        if (params.get('sortOrder') != null) {
                            viewPref.sortOrder = params.get('sortOrder');
                        }
                        const page = parseInt(params.get('page') || '0', 10);
                        return {...viewPref, page, search: params.get('search') || ''};
                    })
                )
            }>
            {pref => children(pref)}
        </DataLoader>
    );
};

function tryJsonParse(input: string) {
    try {
        return (input && JSON.parse(input)) || null;
    } catch {
        return null;
    }
}

const SearchBar = (props: {content: string; ctx: ContextApis; apps: models.Application[]; onSearchChange?: () => void}) => {
    const {content, ctx, apps, onSearchChange} = {...props};

    const searchBar = React.useRef<HTMLDivElement>(null);
    const [localSearch, setLocalSearch] = React.useState(content || '');

    // Sync local state when the URL-driven content changes externally
    React.useEffect(() => {
        setLocalSearch(content || '');
    }, [content]);

    const query = new URLSearchParams(window.location.search);
    const appInput = tryJsonParse(query.get('new'));

    const {useKeybinding} = React.useContext(KeybindingContext);
    const [isFocused, setFocus] = React.useState(false);
    const useAuthSettingsCtx = React.useContext(AuthSettingsCtx);

    useKeybinding({
        keys: Key.SLASH,
        action: () => {
            if (searchBar.current && !appInput) {
                searchBar.current.querySelector('input').focus();
                setFocus(true);
                return true;
            }
            return false;
        }
    });

    useKeybinding({
        keys: Key.ESCAPE,
        action: () => {
            if (searchBar.current && !appInput && isFocused) {
                searchBar.current.querySelector('input').blur();
                setFocus(false);
                return true;
            }
            return false;
        }
    });

    // Filter suggestions locally using regex
    const suggestions = React.useMemo(() => {
        if (!localSearch) return apps.map(app => AppUtils.appQualifiedName(app, useAuthSettingsCtx?.appsInAnyNamespaceEnabled));
        try {
            const re = new RegExp(localSearch, 'i');
            return apps
                .filter(app => re.test(app.metadata.name) || re.test(app.metadata.namespace))
                .map(app => AppUtils.appQualifiedName(app, useAuthSettingsCtx?.appsInAnyNamespaceEnabled));
        } catch {
            // Invalid regex, fallback to substring
            const lower = localSearch.toLowerCase();
            return apps
                .filter(app => app.metadata.name.toLowerCase().includes(lower) || app.metadata.namespace.toLowerCase().includes(lower))
                .map(app => AppUtils.appQualifiedName(app, useAuthSettingsCtx?.appsInAnyNamespaceEnabled));
        }
    }, [localSearch, apps]);

    const submitSearch = (value: string) => {
        ctx.navigation.goto('.', {search: value || null, page: '0'}, {replace: true});
        if (onSearchChange) {
            onSearchChange();
        }
    };

    return (
        <Autocomplete
            filterSuggestions={true}
            renderInput={inputProps => (
                <div className='applications-list__search' ref={searchBar}>
                    <i
                        className='fa fa-search'
                        style={{marginRight: '9px', cursor: 'pointer'}}
                        onClick={() => {
                            if (searchBar.current) {
                                searchBar.current.querySelector('input').focus();
                            }
                        }}
                    />
                    <input
                        {...inputProps}
                        onFocus={e => {
                            e.target.select();
                            if (inputProps.onFocus) {
                                inputProps.onFocus(e);
                            }
                        }}
                        onKeyDown={e => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                submitSearch(localSearch);
                            }
                            if (inputProps.onKeyDown) {
                                inputProps.onKeyDown(e);
                            }
                        }}
                        style={{fontSize: '14px'}}
                        className='argo-field'
                        placeholder='Search applications (regex supported, Enter to search)...'
                    />
                    <div className='keyboard-hint'>/</div>
                    {localSearch && (
                        <i className='fa fa-times' onClick={() => { setLocalSearch(''); submitSearch(''); }} style={{cursor: 'pointer', marginLeft: '5px'}} />
                    )}
                </div>
            )}
            wrapperProps={{className: 'applications-list__search-wrapper'}}
            renderItem={item => (
                <React.Fragment>
                    <i className='icon argo-icon-application' /> {item.label}
                </React.Fragment>
            )}
            onSelect={val => {
                const selectedApp = apps?.find(app => {
                    const qualifiedName = AppUtils.appQualifiedName(app, useAuthSettingsCtx?.appsInAnyNamespaceEnabled);
                    return qualifiedName === val;
                });
                if (selectedApp) {
                    ctx.navigation.goto(`/${AppUtils.getAppUrl(selectedApp)}`);
                }
            }}
            onChange={e => {
                setLocalSearch(e.target.value);
            }}
            value={localSearch}
            items={suggestions}
        />
    );
};

interface ApplicationsToolbarProps {
    applications: models.Application[];
    pref: AppsListPreferences & {page: number; search: string};
    ctx: ContextApis;
    healthBarPrefs: HealthStatusBarPreferences;
    onSearchChange?: () => void;
}

const ApplicationsToolbar: React.FC<ApplicationsToolbarProps> = ({applications, pref, ctx, healthBarPrefs, onSearchChange}) => {
    const {List, Summary, Tiles} = AppsListViewKey;
    const query = useQuery();

    return (
        <React.Fragment key='app-list-tools'>
            <SearchBar content={query.get('search')} apps={applications} ctx={ctx} onSearchChange={onSearchChange} />
            <Tooltip content='Toggle Health Status Bar'>
                <button
                    className={`applications-list__accordion argo-button argo-button--base${healthBarPrefs.showHealthStatusBar ? '-o' : ''}`}
                    style={{border: 'none'}}
                    onClick={() => {
                        healthBarPrefs.showHealthStatusBar = !healthBarPrefs.showHealthStatusBar;
                        services.viewPreferences.updatePreferences({
                            appList: {
                                ...pref,
                                statusBarView: {
                                    ...healthBarPrefs,
                                    showHealthStatusBar: healthBarPrefs.showHealthStatusBar
                                }
                            }
                        });
                    }}>
                    <i className={`fas fa-ruler-horizontal`} />
                </button>
            </Tooltip>
            <Tooltip content={pref.backendFilterAndPagination ? 'Server-side Filter & Pagination (click for client-side)' : 'Client-side Filter & Pagination (click for server-side)'}>
                <button
                    className={`applications-list__accordion argo-button argo-button--base`}
                    style={{border: 'none', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px'}}
                    onClick={() => {
                        services.viewPreferences.updatePreferences({
                            appList: {
                                ...pref,
                                backendFilterAndPagination: !pref.backendFilterAndPagination
                            }
                        });
                        ctx.navigation.goto('.', {page: '0'}, {replace: true});
                    }}>
                    <i className={pref.backendFilterAndPagination ? 'fas fa-server' : 'fas fa-desktop'} />
                    <span className='show-for-large'>{pref.backendFilterAndPagination ? 'Backend Filter & Pagination' : 'Frontend Filter & Pagination'}</span>
                </button>
            </Tooltip>
            <div className='applications-list__view-type' style={{marginLeft: 'auto'}}>
                <i
                    className={classNames('fa fa-th', {selected: pref.view === Tiles}, 'menu_icon')}
                    title='Tiles'
                    onClick={() => {
                        ctx.navigation.goto('.', {view: Tiles});
                        services.viewPreferences.updatePreferences({appList: {...pref, view: Tiles}});
                    }}
                />
                <i
                    className={classNames('fa fa-th-list', {selected: pref.view === List}, 'menu_icon')}
                    title='List'
                    onClick={() => {
                        ctx.navigation.goto('.', {view: List});
                        services.viewPreferences.updatePreferences({appList: {...pref, view: List}});
                    }}
                />
                <i
                    className={classNames('fa fa-chart-pie', {selected: pref.view === Summary}, 'menu_icon')}
                    title='Summary'
                    onClick={() => {
                        ctx.navigation.goto('.', {view: Summary});
                        services.viewPreferences.updatePreferences({appList: {...pref, view: Summary}});
                    }}
                />
            </div>
        </React.Fragment>
    );
};

const FlexTopBar = (props: {toolbar: Toolbar | Observable<Toolbar>}) => {
    const ctx = React.useContext(Context);
    const loadToolbar = AddAuthToToolbar(props.toolbar, ctx);
    return (
        <React.Fragment>
            <div className='top-bar row flex-top-bar' key='tool-bar'>
                <DataLoader load={() => loadToolbar}>
                    {toolbar => (
                        <React.Fragment>
                            <div className='flex-top-bar__actions'>
                                {toolbar.actionMenu && (
                                    <React.Fragment>
                                        {toolbar.actionMenu.items.map((item, i) => (
                                            <Tooltip className='custom-tooltip' content={item.title} key={item.qeId || i}>
                                                <button
                                                    disabled={!!item.disabled}
                                                    qe-id={item.qeId}
                                                    className='argo-button argo-button--base'
                                                    onClick={() => item.action()}
                                                    style={{marginRight: 2}}
                                                    key={i}>
                                                    {item.iconClassName && <i className={item.iconClassName} style={{marginLeft: '-5px', marginRight: '5px'}} />}
                                                    <span className='show-for-large'>{item.title}</span>
                                                </button>
                                            </Tooltip>
                                        ))}
                                    </React.Fragment>
                                )}
                            </div>
                            <div className='flex-top-bar__tools'>{toolbar.tools}</div>
                        </React.Fragment>
                    )}
                </DataLoader>
            </div>
            <div className='flex-top-bar__padder' />
        </React.Fragment>
    );
};

export const ApplicationsList = (props: RouteComponentProps<any>) => {
    const query = useQuery();
    const observableQuery$ = useObservableQuery();
    const appInput = tryJsonParse(query.get('new'));
    const syncAppsInput = tryJsonParse(query.get('syncApps'));
    const refreshAppsInput = tryJsonParse(query.get('refreshApps'));
    const [createApi, setCreateApi] = React.useState(null);
    const clusters = React.useMemo(() => services.clusters.list(), []);
    const [isAppCreatePending, setAppCreatePending] = React.useState(false);
    const loaderRef = React.useRef<DataLoader>();
    const {List, Summary, Tiles} = AppsListViewKey;
    const authSettings = React.useContext(AuthSettingsCtx);
    const serverPageSize = authSettings?.appListChunkSize || DEFAULT_SERVER_PAGE_SIZE;

    const [pageSize, setPageSize] = React.useState(serverPageSize);

    function refreshApp(appName: string, appNamespace: string) {
        // app refreshing might be done too quickly so that UI might miss it due to event batching
        // add refreshing annotation in the UI to improve user experience
        if (loaderRef.current) {
            const data = loaderRef.current.getData();
            // Handle both backend mode (LoadResult) and frontend mode (Application[])
            if (data && typeof data === 'object' && 'applications' in data) {
                const loadResult = data as LoadResult;
                const app = loadResult.applications?.find(item => item.metadata.name === appName && item.metadata.namespace === appNamespace);
                if (app) {
                    AppUtils.setAppRefreshing(app);
                    loaderRef.current.setData(loadResult);
                }
            } else if (Array.isArray(data)) {
                const applications = data as models.Application[];
                const app = applications.find(item => item.metadata.name === appName && item.metadata.namespace === appNamespace);
                if (app) {
                    AppUtils.setAppRefreshing(app);
                    loaderRef.current.setData(applications);
                }
            }
        }
        services.applications.get(appName, appNamespace, 'application', 'normal');
    }

    function onAppFilterPrefChanged(ctx: ContextApis, newPref: AppsListPreferences) {
        services.viewPreferences.updatePreferences({appList: newPref});
        ctx.navigation.goto(
            '.',
            {
                proj: newPref.projectsFilter.join(','),
                sync: newPref.syncFilter.join(','),
                autoSync: newPref.autoSyncFilter.join(','),
                health: newPref.healthFilter.join(','),
                namespace: newPref.namespacesFilter.join(','),
                targetRevision: newPref.targetRevisionFilter.map(encodeURIComponent).join(','),
                repo: newPref.reposFilter.map(encodeURIComponent).join(','),
                cluster: newPref.clustersFilter.join(','),
                labels: newPref.labelsFilter.map(encodeURIComponent).join(','),
                annotations: newPref.annotationsFilter.map(encodeURIComponent).join(','),
                operation: newPref.operationFilter.join(','),
                page: '0',
                // Keep URL and preferences consistent. When false, remove the param entirely.
                showFavorites: newPref.showFavorites ? 'true' : null
            },
            {replace: true}
        );
    }

    function getPageTitle(view: string) {
        switch (view) {
            case List:
                return 'Applications List';
            case Tiles:
                return 'Applications Tiles';
            case Summary:
                return 'Applications Summary';
        }
        return '';
    }

    const sidebarTarget = useSidebarTarget();

    return (
        <ClusterCtx.Provider value={clusters}>
            <KeybindingProvider>
                <Consumer>
                    {ctx => (
                        <ViewPref>
                            {pref => {
                                const serverBatchOffset = pref.page * (pageSize > 0 ? pageSize : serverPageSize);
                                return (
                                <Page
                                    key={pref.view}
                                    title={getPageTitle(pref.view)}
                                    useTitleOnly={true}
                                    toolbar={{
                                        breadcrumbs: [
                                            {
                                                title: 'Applications',
                                                path: props.match.url
                                            }
                                        ]
                                    }}
                                    hideAuth={true}>
                                    {pref.backendFilterAndPagination ? (
                                    <DataLoader
                                        key='backend-loader'
                                        noLoaderOnInputChange={true}
                                        input={buildFilterInputKey({
                                            projects: pref.projectsFilter || [],
                                            appNamespace: query.get('appNamespace') || '',
                                            syncStatuses: pref.syncFilter || [],
                                            healthStatuses: pref.healthFilter || [],
                                            clusters: pref.clustersFilter || [],
                                            namespaces: pref.namespacesFilter || [],
                                            autoSyncStatuses: pref.autoSyncFilter || [],
                                            repos: pref.reposFilter || [],
                                            targetRevisions: pref.targetRevisionFilter || [],
                                            operations: pref.operationFilter || [],
                                            search: pref.search || '',
                                            sortBy: pref.sortBy || '',
                                            sortOrder: pref.sortOrder || '',
                                            offset: serverBatchOffset,
                                            limit: pageSize,
                                            selector: (pref.labelsFilter || []).join(','),
                                            annotationsFilter: pref.annotationsFilter || []
                                        })}
                                        ref={loaderRef}
                                        load={() => {
                                            const filterParams: ServerFilterParams = {
                                                projects: pref.projectsFilter || [],
                                                appNamespace: query.get('appNamespace') || '',
                                                syncStatuses: pref.syncFilter || [],
                                                healthStatuses: pref.healthFilter || [],
                                                clusters: pref.clustersFilter || [],
                                                namespaces: pref.namespacesFilter || [],
                                                autoSyncStatuses: pref.autoSyncFilter || [],
                                                repos: pref.reposFilter || [],
                                                targetRevisions: pref.targetRevisionFilter || [],
                                                operations: pref.operationFilter || [],
                                                search: pref.search || '',
                                                sortBy: pref.sortBy || '',
                                                sortOrder: pref.sortOrder || '',
                                                offset: serverBatchOffset,
                                                limit: pageSize,
                                                selector: (pref.labelsFilter || []).join(','),
                                                annotationsFilter: pref.annotationsFilter || []
                                            };
                                            return AppUtils.handlePageVisibility(() => loadApplications(filterParams));
                                        }}
                                        loadingRenderer={() => (
                                            <div className='argo-container'>
                                                <MockupList height={100} marginTop={30} />
                                            </div>
                                        )}>
                                        {(loadResult: LoadResult) => {
                                            const applications = loadResult?.applications || [];
                                            const totalCount = loadResult?.totalCount || 0;
                                            const healthBarPrefs = pref.statusBarView || ({} as HealthStatusBarPreferences);
                                            const handleCreatePanelClose = async () => {
                                                const outsideDiv = document.querySelector('.sliding-panel__outside');
                                                const closeButton = document.querySelector('.sliding-panel__close');

                                                if (outsideDiv && closeButton && closeButton !== document.activeElement) {
                                                    const confirmed = await ctx.popup.confirm('Close Panel', 'Closing this panel will discard all entered values. Continue?');
                                                    if (confirmed) {
                                                        ctx.navigation.goto('.', {new: null}, {replace: true});
                                                    }
                                                } else if (closeButton === document.activeElement) {
                                                    ctx.navigation.goto('.', {new: null}, {replace: true});
                                                }
                                            };

                                            const apps = applications as models.Application[];
                                            const filteredApps = apps;
                                            const filterResults = apps.map(app => {
                                                let isAppOfAppsPattern = false;
                                                if (app.status?.resources) {
                                                    for (const resource of app.status.resources) {
                                                        if (resource.kind === 'Application') {
                                                            isAppOfAppsPattern = true;
                                                            break;
                                                        }
                                                    }
                                                }
                                                return {...app, isAppOfAppsPattern, filterResult: {}};
                                            }) as FilteredApp[];
                                            const effectivePageSize = pageSize > 0 ? pageSize : totalCount || 1;
                                            const totalPages = pageSize > 0 ? Math.ceil(totalCount / effectivePageSize) : 1;
                                            const currentPage = pageSize > 0 ? Math.floor(serverBatchOffset / effectivePageSize) : 0;

                                            return (
                                                <React.Fragment>
                                                    <FlexTopBar
                                                        toolbar={{
                                                            tools: <ApplicationsToolbar applications={applications} pref={pref} ctx={ctx} healthBarPrefs={healthBarPrefs} onSearchChange={() => ctx.navigation.goto('.', {page: '0'}, {replace: true})} />,
                                                            actionMenu: {
                                                                items: [
                                                                    {
                                                                        title: 'New App',
                                                                        iconClassName: 'fa fa-plus',
                                                                        qeId: 'applications-list-button-new-app',
                                                                        action: () => ctx.navigation.goto('.', {new: '{}'}, {replace: true})
                                                                    },
                                                                    {
                                                                        title: 'Sync Apps',
                                                                        iconClassName: 'fa fa-sync',
                                                                        action: () => ctx.navigation.goto('.', {syncApps: true}, {replace: true})
                                                                    },
                                                                    {
                                                                        title: 'Refresh Apps',
                                                                        iconClassName: 'fa fa-redo',
                                                                        action: () => ctx.navigation.goto('.', {refreshApps: true}, {replace: true})
                                                                    }
                                                                ]
                                                            }
                                                        }}
                                                    />
                                                    <div className='applications-list'>
                                                        {ReactDOM.createPortal(
                                                            <DataLoader load={() => Promise.all([services.viewPreferences.getPreferences(), services.applications.getFilterOptions()])}>
                                                                {([allpref, filterOpts]) => (
                                                                    <ApplicationsFilter
                                                                        apps={filterResults}
                                                                        onChange={newPrefs => onAppFilterPrefChanged(ctx, newPrefs)}
                                                                        pref={pref}
                                                                        collapsed={allpref.hideSidebar}
                                                                        serverFilterOptions={filterOpts}
                                                                    />
                                                                )}
                                                            </DataLoader>,
                                                            sidebarTarget?.current
                                                        )}

                                                                {(pref.view === 'summary' && <ApplicationsSummary applications={filteredApps} />) || (
                                                                    <>
                                                                        {filteredApps.length > 0 && healthBarPrefs.showHealthStatusBar && (
                                                                            <AppsStatusBar applications={filteredApps} />
                                                                        )}
                                                                        <div className='applications-list__sort-pagination' style={{
                                                                            display: 'flex',
                                                                            alignItems: 'center',
                                                                            justifyContent: 'space-between',
                                                                            padding: '0.5em 1em',
                                                                            borderBottom: '1px solid var(--argo-color-teal-3, #dee6eb)',
                                                                            fontSize: '13px'
                                                                        }}>
                                                                            <span>
                                                                                {totalCount > 0
                                                                                    ? `Showing ${serverBatchOffset + 1}-${Math.min(serverBatchOffset + filteredApps.length, totalCount)} of ${totalCount}`
                                                                                    : 'No applications'}
                                                                            </span>
                                                                            <div style={{display: 'flex', gap: '12px', alignItems: 'center'}}>
                                                                                <label style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
                                                                                    Sort:
                                                                                    <select
                                                                                        value={`${pref.sortBy || 'name'}:${pref.sortOrder || 'asc'}`}
                                                                                        onChange={e => {
                                                                                            const [sortBy, sortOrder] = e.target.value.split(':');
                                                                                            services.viewPreferences.updatePreferences({appList: {...pref, sortBy, sortOrder}});
                                                                                            ctx.navigation.goto('.', {page: '0'}, {replace: true});
                                                                                        }}>
                                                                                        <option value='name:asc'>Name (A-Z)</option>
                                                                                        <option value='name:desc'>Name (Z-A)</option>
                                                                                        <option value='createdAt:desc'>Newest first</option>
                                                                                        <option value='createdAt:asc'>Oldest first</option>
                                                                                        <option value='synchronized:desc'>Last synced</option>
                                                                                        <option value='synchronized:asc'>First synced</option>
                                                                                    </select>
                                                                                </label>
                                                                                <label style={{display: 'flex', alignItems: 'center', gap: '4px'}}>
                                                                                    Items per page:
                                                                                    <select
                                                                                        value={pageSize}
                                                                                        onChange={e => {
                                                                                            const val = parseInt(e.target.value, 10);
                                                                                            setPageSize(val);
                                                                                            ctx.navigation.goto('.', {page: '0'}, {replace: true});
                                                                                        }}>
                                                                                        <option value={5}>5</option>
                                                                                        <option value={10}>10</option>
                                                                                        <option value={15}>15</option>
                                                                                        <option value={20}>20</option>
                                                                                        <option value={serverPageSize}>{serverPageSize}</option>
                                                                                        <option value={0}>All</option>
                                                                                    </select>
                                                                                </label>
                                                                            </div>
                                                                        </div>
                                                                        {totalPages > 1 && (
                                                                            <div className='paginate' style={{paddingLeft: '1em', paddingTop: '0.5em'}}>
                                                                                <ReactPaginate
                                                                                    pageCount={totalPages}
                                                                                    forcePage={currentPage}
                                                                                    onPageChange={({selected}) => {
                                                                                        ctx.navigation.goto('.', {page: String(selected)}, {replace: true});
                                                                                    }}
                                                                                    marginPagesDisplayed={2}
                                                                                    pageRangeDisplayed={5}
                                                                                    containerClassName={'paginate__paginator'}
                                                                                />
                                                                            </div>
                                                                        )}
                                                                        {filteredApps.length === 0 ? (
                                                                            <EmptyState icon='fa fa-search'>
                                                                                <h4>No matching applications found</h4>
                                                                                <h5>
                                                                                    Change filter criteria or&nbsp;
                                                                                    <a
                                                                                        onClick={() => {
                                                                                            AppsListPreferences.clearFilters(pref);
                                                                                            onAppFilterPrefChanged(ctx, pref);
                                                                                        }}>
                                                                                        clear filters
                                                                                    </a>
                                                                                </h5>
                                                                            </EmptyState>
                                                                        ) : (
                                                                            <>
                                                                                {(pref.view === 'tiles' && (
                                                                                    <ApplicationTiles
                                                                                        applications={filteredApps}
                                                                                        syncApplication={(appName, appNamespace) =>
                                                                                            ctx.navigation.goto('.', {syncApp: appName, appNamespace}, {replace: true})
                                                                                        }
                                                                                        refreshApplication={refreshApp}
                                                                                        deleteApplication={(appName, appNamespace) =>
                                                                                            AppUtils.deleteApplication(appName, appNamespace, ctx)
                                                                                        }
                                                                                    />
                                                                                )) || (
                                                                                    <ApplicationsTable
                                                                                        applications={filteredApps}
                                                                                        syncApplication={(appName, appNamespace) =>
                                                                                            ctx.navigation.goto('.', {syncApp: appName, appNamespace}, {replace: true})
                                                                                        }
                                                                                        refreshApplication={refreshApp}
                                                                                        deleteApplication={(appName, appNamespace) =>
                                                                                            AppUtils.deleteApplication(appName, appNamespace, ctx)
                                                                                        }
                                                                                    />
                                                                                )}
                                                                            </>
                                                                        )}
                                                                    </>
                                                                )}
                                                        <ApplicationsSyncPanel
                                                            key='syncsPanel'
                                                            show={syncAppsInput}
                                                            hide={() => ctx.navigation.goto('.', {syncApps: null}, {replace: true})}
                                                            apps={filteredApps}
                                                        />
                                                        <ApplicationsRefreshPanel
                                                            key='refreshPanel'
                                                            show={refreshAppsInput}
                                                            hide={() => ctx.navigation.goto('.', {refreshApps: null}, {replace: true})}
                                                            apps={filteredApps}
                                                        />
                                                    </div>
                                                    <DataLoader
                                                        load={() =>
                                                            observableQuery$.pipe(
                                                                mergeMap(params => {
                                                                    const syncApp = params.get('syncApp');
                                                                    const appNamespace = params.get('appNamespace');
                                                                    return (syncApp && from(services.applications.get(syncApp, appNamespace, 'application'))) || from([null]);
                                                                })
                                                            )
                                                        }>
                                                        {app => (
                                                            <ApplicationSyncPanel
                                                                key='syncPanel'
                                                                application={app}
                                                                selectedResource={'all'}
                                                                hide={() => ctx.navigation.goto('.', {syncApp: null}, {replace: true})}
                                                            />
                                                        )}
                                                    </DataLoader>
                                                    <SlidingPanel
                                                        isShown={!!appInput}
                                                        onClose={() => handleCreatePanelClose()}
                                                        header={
                                                            <div>
                                                                <button
                                                                    qe-id='applications-list-button-create'
                                                                    className='argo-button argo-button--base'
                                                                    disabled={isAppCreatePending}
                                                                    onClick={() => createApi && createApi.submitForm(null)}>
                                                                    <Spinner show={isAppCreatePending} style={{marginRight: '5px'}} />
                                                                    Create
                                                                </button>{' '}
                                                                <button
                                                                    qe-id='applications-list-button-cancel'
                                                                    onClick={() => ctx.navigation.goto('.', {new: null}, {replace: true})}
                                                                    className='argo-button argo-button--base-o'>
                                                                    Cancel
                                                                </button>
                                                            </div>
                                                        }>
                                                        {appInput && (
                                                            <ApplicationCreatePanel
                                                                getFormApi={api => {
                                                                    setCreateApi(api);
                                                                }}
                                                                createApp={async app => {
                                                                    setAppCreatePending(true);
                                                                    try {
                                                                        await services.applications.create(app);
                                                                        ctx.navigation.goto('.', {new: null}, {replace: true});
                                                                    } catch (e) {
                                                                        ctx.notifications.show({
                                                                            content: <ErrorNotification title='Unable to create application' e={e} />,
                                                                            type: NotificationType.Error
                                                                        });
                                                                    } finally {
                                                                        setAppCreatePending(false);
                                                                    }
                                                                }}
                                                                app={appInput}
                                                                onAppChanged={app => ctx.navigation.goto('.', {new: JSON.stringify(app)}, {replace: true})}
                                                            />
                                                        )}
                                                    </SlidingPanel>
                                                </React.Fragment>
                                            );
                                        }}
                                    </DataLoader>
                                    ) : (
                                    <DataLoader
                                        key='frontend-loader'
                                        input={pref.projectsFilter?.join(',')}
                                        ref={loaderRef}
                                        load={() => AppUtils.handlePageVisibility(() => loadAllApplications(pref.projectsFilter, query.get('appNamespace')))}
                                        loadingRenderer={() => (
                                            <div className='argo-container'>
                                                <MockupList height={100} marginTop={30} />
                                            </div>
                                        )}>
                                        {(applications: models.Application[]) => {
                                            const allApps = applications || [];
                                            const healthBarPrefs = pref.statusBarView || ({} as HealthStatusBarPreferences);
                                            const handleCreatePanelClose = async () => {
                                                const outsideDiv = document.querySelector('.sliding-panel__outside');
                                                const closeButton = document.querySelector('.sliding-panel__close');

                                                if (outsideDiv && closeButton && closeButton !== document.activeElement) {
                                                    const confirmed = await ctx.popup.confirm('Close Panel', 'Closing this panel will discard all entered values. Continue?');
                                                    if (confirmed) {
                                                        ctx.navigation.goto('.', {new: null}, {replace: true});
                                                    }
                                                } else if (closeButton === document.activeElement) {
                                                    ctx.navigation.goto('.', {new: null}, {replace: true});
                                                }
                                            };

                                            const apps = allApps as models.Application[];
                                            const {filteredApps, filterResults} = filterApplications(apps, pref, pref.search || '');

                                            return (
                                                <React.Fragment>
                                                    <FlexTopBar
                                                        toolbar={{
                                                            tools: <ApplicationsToolbar applications={applications} pref={pref} ctx={ctx} healthBarPrefs={healthBarPrefs} />,
                                                            actionMenu: {
                                                                items: [
                                                                    {
                                                                        title: 'New App',
                                                                        iconClassName: 'fa fa-plus',
                                                                        qeId: 'applications-list-button-new-app',
                                                                        action: () => ctx.navigation.goto('.', {new: '{}'}, {replace: true})
                                                                    },
                                                                    {
                                                                        title: 'Sync Apps',
                                                                        iconClassName: 'fa fa-sync',
                                                                        action: () => ctx.navigation.goto('.', {syncApps: true}, {replace: true})
                                                                    },
                                                                    {
                                                                        title: 'Refresh Apps',
                                                                        iconClassName: 'fa fa-redo',
                                                                        action: () => ctx.navigation.goto('.', {refreshApps: true}, {replace: true})
                                                                    }
                                                                ]
                                                            }
                                                        }}
                                                    />
                                                    <div className='applications-list'>
                                                        {ReactDOM.createPortal(
                                                            <DataLoader load={() => services.viewPreferences.getPreferences()}>
                                                                {allpref => (
                                                                    <ApplicationsFilter
                                                                        apps={filterResults}
                                                                        onChange={newPrefs => onAppFilterPrefChanged(ctx, newPrefs)}
                                                                        pref={pref}
                                                                        collapsed={allpref.hideSidebar}
                                                                    />
                                                                )}
                                                            </DataLoader>,
                                                            sidebarTarget?.current
                                                        )}

                                                        {apps.length === 0 && pref.projectsFilter?.length === 0 && (pref.labelsFilter || []).length === 0 ? (
                                                            <EmptyState icon='argo-icon-application'>
                                                                <h4>No applications available to you just yet</h4>
                                                                <h5>
                                                                    Create new application to start managing resources in your cluster
                                                                </h5>
                                                                <p>
                                                                    <a
                                                                        className='argo-button argo-button--base'
                                                                        onClick={() => ctx.navigation.goto('.', {new: JSON.stringify({})}, {replace: true})}>
                                                                        <i className='fa fa-plus' /> New App
                                                                    </a>
                                                                </p>
                                                            </EmptyState>
                                                        ) : (
                                                            <>
                                                                {(pref.view === 'summary' && <ApplicationsSummary applications={filteredApps} />) || (
                                                                    <Paginate
                                                                        page={pref.page}
                                                                        onPageChange={page => ctx.navigation.goto('.', {page: String(page)}, {replace: true})}
                                                                        data={filteredApps}
                                                                        preferencesKey='applications-list'>
                                                                        {data => (
                                                                            <>
                                                                                {data.length > 0 && healthBarPrefs.showHealthStatusBar && (
                                                                                    <AppsStatusBar applications={data} />
                                                                                )}
                                                                                {data.length === 0 ? (
                                                                                    <EmptyState icon='fa fa-search'>
                                                                                        <h4>No matching applications found</h4>
                                                                                        <h5>
                                                                                            Change filter criteria or&nbsp;
                                                                                            <a
                                                                                                onClick={() => {
                                                                                                    AppsListPreferences.clearFilters(pref);
                                                                                                    onAppFilterPrefChanged(ctx, pref);
                                                                                                }}>
                                                                                                clear filters
                                                                                            </a>
                                                                                        </h5>
                                                                                    </EmptyState>
                                                                                ) : (
                                                                                    <>
                                                                                        {(pref.view === 'tiles' && (
                                                                                            <ApplicationTiles
                                                                                                applications={data}
                                                                                                syncApplication={(appName, appNamespace) =>
                                                                                                    ctx.navigation.goto('.', {syncApp: appName, appNamespace}, {replace: true})
                                                                                                }
                                                                                                refreshApplication={refreshApp}
                                                                                                deleteApplication={(appName, appNamespace) =>
                                                                                                    AppUtils.deleteApplication(appName, appNamespace, ctx)
                                                                                                }
                                                                                            />
                                                                                        )) || (
                                                                                            <ApplicationsTable
                                                                                                applications={data}
                                                                                                syncApplication={(appName, appNamespace) =>
                                                                                                    ctx.navigation.goto('.', {syncApp: appName, appNamespace}, {replace: true})
                                                                                                }
                                                                                                refreshApplication={refreshApp}
                                                                                                deleteApplication={(appName, appNamespace) =>
                                                                                                    AppUtils.deleteApplication(appName, appNamespace, ctx)
                                                                                                }
                                                                                            />
                                                                                        )}
                                                                                    </>
                                                                                )}
                                                                            </>
                                                                        )}
                                                                    </Paginate>
                                                                )}
                                                            </>
                                                        )}
                                                        <ApplicationsSyncPanel
                                                            key='syncsPanel'
                                                            show={syncAppsInput}
                                                            hide={() => ctx.navigation.goto('.', {syncApps: null}, {replace: true})}
                                                            apps={filteredApps}
                                                        />
                                                        <ApplicationsRefreshPanel
                                                            key='refreshPanel'
                                                            show={refreshAppsInput}
                                                            hide={() => ctx.navigation.goto('.', {refreshApps: null}, {replace: true})}
                                                            apps={filteredApps}
                                                        />
                                                    </div>
                                                    <DataLoader
                                                        load={() =>
                                                            observableQuery$.pipe(
                                                                mergeMap(params => {
                                                                    const syncApp = params.get('syncApp');
                                                                    const appNamespace = params.get('appNamespace');
                                                                    return (syncApp && from(services.applications.get(syncApp, appNamespace, 'application'))) || from([null]);
                                                                })
                                                            )
                                                        }>
                                                        {app => (
                                                            <ApplicationSyncPanel
                                                                key='syncPanel'
                                                                application={app}
                                                                selectedResource={'all'}
                                                                hide={() => ctx.navigation.goto('.', {syncApp: null}, {replace: true})}
                                                            />
                                                        )}
                                                    </DataLoader>
                                                    <SlidingPanel
                                                        isShown={!!appInput}
                                                        onClose={() => handleCreatePanelClose()}
                                                        header={
                                                            <div>
                                                                <button
                                                                    qe-id='applications-list-button-create'
                                                                    className='argo-button argo-button--base'
                                                                    disabled={isAppCreatePending}
                                                                    onClick={() => createApi && createApi.submitForm(null)}>
                                                                    <Spinner show={isAppCreatePending} style={{marginRight: '5px'}} />
                                                                    Create
                                                                </button>{' '}
                                                                <button
                                                                    qe-id='applications-list-button-cancel'
                                                                    onClick={() => ctx.navigation.goto('.', {new: null}, {replace: true})}
                                                                    className='argo-button argo-button--base-o'>
                                                                    Cancel
                                                                </button>
                                                            </div>
                                                        }>
                                                        {appInput && (
                                                            <ApplicationCreatePanel
                                                                getFormApi={api => {
                                                                    setCreateApi(api);
                                                                }}
                                                                createApp={async app => {
                                                                    setAppCreatePending(true);
                                                                    try {
                                                                        await services.applications.create(app);
                                                                        ctx.navigation.goto('.', {new: null}, {replace: true});
                                                                    } catch (e) {
                                                                        ctx.notifications.show({
                                                                            content: <ErrorNotification title='Unable to create application' e={e} />,
                                                                            type: NotificationType.Error
                                                                        });
                                                                    } finally {
                                                                        setAppCreatePending(false);
                                                                    }
                                                                }}
                                                                app={appInput}
                                                                onAppChanged={app => ctx.navigation.goto('.', {new: JSON.stringify(app)}, {replace: true})}
                                                            />
                                                        )}
                                                    </SlidingPanel>
                                                </React.Fragment>
                                            );
                                        }}
                                    </DataLoader>
                                    )}
                                </Page>
                            );}}
                        </ViewPref>
                    )}
                </Consumer>
            </KeybindingProvider>
        </ClusterCtx.Provider>
    );
};
