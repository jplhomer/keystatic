import { useLocalizedStringFormatter } from '@react-aria/i18n';
import {
  Key,
  ReactElement,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { ActionGroup } from '@keystar/ui/action-group';
import { Badge } from '@keystar/ui/badge';
import { Breadcrumbs, Item } from '@keystar/ui/breadcrumbs';
import { Button, ButtonGroup } from '@keystar/ui/button';
import { AlertDialog, Dialog, DialogContainer } from '@keystar/ui/dialog';
import { Icon } from '@keystar/ui/icon';
import { copyPlusIcon } from '@keystar/ui/icon/icons/copyPlusIcon';
import { externalLinkIcon } from '@keystar/ui/icon/icons/externalLinkIcon';
import { historyIcon } from '@keystar/ui/icon/icons/historyIcon';
import { trash2Icon } from '@keystar/ui/icon/icons/trash2Icon';
import { Box, Flex } from '@keystar/ui/layout';
import { Notice } from '@keystar/ui/notice';
import { ProgressCircle } from '@keystar/ui/progress';
import { Content } from '@keystar/ui/slots';
import {
  breakpointQueries,
  css,
  tokenSchema,
  useMediaQuery,
} from '@keystar/ui/style';
import { TextField } from '@keystar/ui/text-field';
import { Heading, Text } from '@keystar/ui/typography';

import { Config } from '../config';
import { createGetPreviewProps } from '../form/preview-props';
import { fields } from '../form/api';

import {
  prettyErrorForCreateBranchMutation,
  useCreateBranchMutation,
} from './branch-selection';
import { FormForEntry, containerWidthForEntryLayout } from './entry-form';
import l10nMessages from './l10n/index.json';
import { getDataFileExtension, getPathPrefix } from './path-utils';
import { useRouter } from './router';
import { PageBody, PageHeader, PageRoot } from './shell/page';
import {
  useRepositoryId,
  useBranchInfo,
  useTree,
  useCurrentUnscopedTree,
} from './shell/data';
import { serializeEntryToFiles } from './updating';
import { useItemData } from './useItemData';
import { useHasChanged } from './useHasChanged';
import {
  getBranchPrefix,
  getCollectionFormat,
  getCollectionItemPath,
  getRepoUrl,
  getSlugFromState,
} from './utils';
import { notFound } from './not-found';
import { useConfig } from './shell/context';
import { useSlugFieldInfo } from './slugs';
import { LOADING, useData } from './useData';
import { githubIcon } from '@keystar/ui/icon/icons/githubIcon';
import { useYjs, useYjsIfAvailable } from './shell/collab';
import * as Y from 'yjs';
import { getYjsValFromParsedValue } from '../form/props-value';
import { useYJsValue } from './useYJsValue';
import { createGetPreviewPropsFromY } from '../form/preview-props-yjs';
import {
  setTreeToPersistedCache,
  useExtraRoots,
  writeChangesToLocalObjectStore,
} from './object-store';
import { updateTreeWithChanges } from './trees';
import { getInitialPropsValue } from '../form/initial-values';

type ItemPageProps = {
  collection: string;
  config: Config;
  initialFiles: string[];
  initialState: Record<string, unknown>;
  committedState: Record<string, unknown> | null;
  itemSlug: string;
  localTreeKey: string;
  basePath: string;
};

function ItemPageInner(
  props: ItemPageProps & {
    onReset: () => void;
    previewProps: ReturnType<ReturnType<typeof createGetPreviewProps>>;
    hasChanged: boolean;
    state: Record<string, unknown>;
  }
) {
  const { collection, config, itemSlug } = props;
  const collectionConfig = props.config.collections![collection]!;

  const router = useRouter();
  const currentBasePath = getCollectionItemPath(config, collection, itemSlug);
  const formatInfo = getCollectionFormat(config, collection);
  const extraRoots = useExtraRoots();
  const tree = useTree();
  const currentTree = tree.current.kind === 'loaded' ? tree.current.data : null;
  const branchInfo = useBranchInfo();
  const previewHref = useMemo(() => {
    return collectionConfig.previewUrl
      ? collectionConfig
          .previewUrl!.replace('{slug}', props.itemSlug)
          .replace('{branch}', branchInfo.currentBranch)
      : undefined;
  }, [branchInfo.currentBranch, collectionConfig.previewUrl, props.itemSlug]);
  const onDelete = async () => {
    if (currentTree) {
      // TODO: delete multiplayer draft
      const newTree = await updateTreeWithChanges(currentTree.tree, {
        deletions: props.initialFiles.map(
          x => (getPathPrefix(props.config.storage) ?? '') + x
        ),
        additions: [],
      });
      await setTreeToPersistedCache(newTree.sha, newTree.tree);
      extraRoots.set(branchInfo.currentBranch, newTree.sha);
      router.push(
        `${props.basePath}/collection/${encodeURIComponent(collection)}`
      );
    }
  };

  const slugInfo = useSlugFieldInfo(collection, itemSlug);

  const onDuplicate = () => {
    router.push(
      `${props.basePath}/collection/${encodeURIComponent(
        collection
      )}/create?duplicate=${itemSlug}`
    );
  };

  const viewHref =
    config.storage.kind !== 'local'
      ? `${getRepoUrl(branchInfo)}${
          formatInfo.dataLocation === 'index'
            ? `/tree/${branchInfo.currentBranch}/${
                getPathPrefix(config.storage) ?? ''
              }${currentBasePath}`
            : `/blob/${branchInfo.currentBranch}/${
                getPathPrefix(config.storage) ?? ''
              }${currentBasePath}${getDataFileExtension(formatInfo)}`
        }`
      : undefined;

  return (
    <>
      <ItemPageShell
        headerActions={
          <HeaderActions
            hasChanged={props.hasChanged}
            onDelete={onDelete}
            onDuplicate={onDuplicate}
            onReset={props.onReset}
            viewHref={viewHref}
            previewHref={previewHref}
          />
        }
        {...props}
      >
        <Box height="100%" minHeight={0} minWidth={0}>
          <FormForEntry
            previewProps={props.previewProps as any}
            forceValidation={false}
            entryLayout={collectionConfig.entryLayout}
            formatInfo={formatInfo}
            slugField={slugInfo}
          />
        </Box>
      </ItemPageShell>
    </>
  );
}

function LocalItemPage(props: ItemPageProps) {
  const { collection, config, initialState, localTreeKey } = props;
  const collectionConfig = config.collections![collection]!;
  const schema = useMemo(
    () => fields.object(collectionConfig.schema),
    [collectionConfig.schema]
  );

  const [{ state, localTreeKey: localTreeKeyInState }, setState] = useState({
    state: initialState,
    localTreeKey,
  });
  if (localTreeKeyInState !== localTreeKey) {
    setState({ state: initialState, localTreeKey });
  }

  const previewProps = useMemo(
    () =>
      createGetPreviewProps(
        schema,
        stateUpdater => {
          setState(state => ({
            localTreeKey: state.localTreeKey,
            state: stateUpdater(state.state),
          }));
        },
        () => undefined
      ),
    [schema]
  )(state as Record<string, unknown>);

  const hasChanged = useHasChanged({
    initialState: props.committedState,
    schema,
    state: props.initialState,
    slugField: collectionConfig.slugField,
  });

  const slug = getSlugFromState(collectionConfig, state);
  const futureBasePath = getCollectionItemPath(config, collection, slug);

  const unscopedTreeData = useCurrentUnscopedTree();
  const branchInfo = useBranchInfo();
  const extraRoots = useExtraRoots();

  useEffect(() => {
    if (unscopedTreeData.kind !== 'loaded') return;
    const unscopedTree = unscopedTreeData.data.tree;
    const pathPrefix = getPathPrefix(config.storage) ?? '';
    let additions = serializeEntryToFiles({
      basePath: futureBasePath,
      config,
      format: getCollectionFormat(config, collection),
      schema: collectionConfig.schema,
      slug: { field: collectionConfig.slugField, value: slug },
      state,
    }).map(addition => ({
      ...addition,
      path: pathPrefix + addition.path,
    }));

    writeChangesToLocalObjectStore({
      additions,
      initialFiles: props.initialFiles.map(x => pathPrefix + x),
      currentBranch: branchInfo.currentBranch,
      extraRoots,
      unscopedTree,
    });
  }, [
    collection,
    collectionConfig,
    config,
    futureBasePath,
    localTreeKey,
    props.itemSlug,
    slug,
    state,
    hasChanged,
    props.initialFiles,
    unscopedTreeData,
    extraRoots,
    branchInfo.currentBranch,
  ]);

  const onReset = () => {
    setState({
      state: props.committedState ?? getInitialPropsValue(schema),
      localTreeKey,
    });
  };
  return (
    <ItemPageInner
      {...props}
      onReset={onReset}
      previewProps={previewProps}
      state={state}
      hasChanged={hasChanged}
    />
  );
}

function CollabItemPage(props: ItemPageProps & { map: Y.Map<any> }) {
  const { collection, config, initialState } = props;
  const collectionConfig = config.collections![collection]!;
  const schema = useMemo(
    () => fields.object(collectionConfig.schema),
    [collectionConfig.schema]
  );
  const yjsInfo = useYjs();
  const state = useYJsValue(schema, props.map) as Record<string, unknown>;
  const previewProps = useMemo(
    () =>
      createGetPreviewPropsFromY(schema as any, props.map, yjsInfo.awareness),
    [props.map, schema, yjsInfo.awareness]
  )(state);

  const hasChanged = useHasChanged({
    initialState,
    schema,
    state,
    slugField: collectionConfig.slugField,
  });

  const onReset = () => {
    props.map.doc!.transact(() => {
      for (const [key, value] of Object.entries(collectionConfig.schema)) {
        const val = getYjsValFromParsedValue(
          value,
          props.committedState === null
            ? getInitialPropsValue(value)
            : props.committedState[key]
        );
        props.map.set(key, val);
      }
    });
  };
  return (
    <ItemPageInner
      {...props}
      onReset={onReset}
      previewProps={previewProps}
      state={state}
      hasChanged={hasChanged}
    />
  );
}

function HeaderActions(props: {
  hasChanged: boolean;
  onDelete: () => void;
  onDuplicate: () => void;
  onReset: () => void;
  previewHref?: string;
  viewHref?: string;
}) {
  let { hasChanged, onDelete, onDuplicate, onReset, previewHref, viewHref } =
    props;
  const isBelowTablet = useMediaQuery(breakpointQueries.below.tablet);
  const [deleteAlertIsOpen, setDeleteAlertOpen] = useState(false);
  const [duplicateAlertIsOpen, setDuplicateAlertOpen] = useState(false);
  const menuActions = useMemo(() => {
    type ActionType = {
      icon: ReactElement;
      isDisabled?: boolean;
      key: Key;
      label: string;
      href?: string;
      target?: string;
      rel?: string;
    };
    let items: ActionType[] = [
      {
        key: 'reset',
        label: 'Reset changes', // TODO: l10n
        icon: historyIcon,
      },
      {
        key: 'delete',
        label: 'Delete entry…', // TODO: l10n
        icon: trash2Icon,
      },
      {
        key: 'duplicate',
        label: 'Duplicate entry…', // TODO: l10n
        icon: copyPlusIcon,
      },
    ];
    if (previewHref) {
      items.push({
        key: 'preview',
        label: 'Preview',
        icon: externalLinkIcon,
        href: previewHref,
        target: '_blank',
        rel: 'noopener noreferrer',
      });
    }
    if (viewHref) {
      items.push({
        key: 'view',
        label: 'View on GitHub',
        icon: githubIcon,
        href: viewHref,
        target: '_blank',
        rel: 'noopener noreferrer',
      });
    }

    return items;
  }, [previewHref, viewHref]);

  const indicatorElement = (() => {
    if (hasChanged) {
      return isBelowTablet ? (
        <Box
          backgroundColor="pendingEmphasis"
          height="scale.75"
          width="scale.75"
          borderRadius="full"
        >
          <Text visuallyHidden>Unsaved</Text>
        </Box>
      ) : (
        <Badge tone="pending">Unsaved</Badge>
      );
    }

    return null;
  })();

  return (
    <>
      {indicatorElement}
      <ActionGroup
        buttonLabelBehavior="hide"
        overflowMode="collapse"
        prominence="low"
        density="compact"
        maxWidth={isBelowTablet ? 'element.regular' : undefined} // force switch to action menu on small devices
        items={menuActions}
        disabledKeys={hasChanged ? [] : ['reset']}
        onAction={key => {
          switch (key) {
            case 'reset':
              onReset();
              break;
            case 'delete':
              setDeleteAlertOpen(true);
              break;
            case 'duplicate':
              if (hasChanged) {
                setDuplicateAlertOpen(true);
              } else {
                onDuplicate();
              }
              break;
          }
        }}
      >
        {item => (
          <Item
            key={item.key}
            textValue={item.label}
            href={item.href}
            target={item.target}
            rel={item.rel}
          >
            <Icon src={item.icon} />
            <Text>{item.label}</Text>
          </Item>
        )}
      </ActionGroup>
      <DialogContainer onDismiss={() => setDeleteAlertOpen(false)}>
        {deleteAlertIsOpen && (
          <AlertDialog
            title="Delete entry"
            tone="critical"
            cancelLabel="Cancel"
            primaryActionLabel="Yes, delete"
            autoFocusButton="cancel"
            onPrimaryAction={onDelete}
          >
            Are you sure? This action cannot be undone.
          </AlertDialog>
        )}
      </DialogContainer>
      <DialogContainer onDismiss={() => setDuplicateAlertOpen(false)}>
        {duplicateAlertIsOpen && (
          <AlertDialog
            title="Save and duplicate entry"
            tone="neutral"
            cancelLabel="Cancel"
            primaryActionLabel="Save and duplicate"
            autoFocusButton="primary"
            onPrimaryAction={onDuplicate}
          >
            You have unsaved changes. Save this entry to duplicate it.
          </AlertDialog>
        )}
      </DialogContainer>
    </>
  );
}

export function CreateBranchDuringUpdateDialog(props: {
  branchOid: string;
  onCreate: (branchName: string) => void;
  onDismiss: () => void;
  reason: string;
}) {
  const stringFormatter = useLocalizedStringFormatter(l10nMessages);
  const repositoryId = useRepositoryId();
  const [branchName, setBranchName] = useState('');
  const [{ error, fetching, data }, createBranch] = useCreateBranchMutation();
  const isLoading = fetching || !!data?.createRef?.__typename;

  const config = useConfig();
  const branchPrefix = getBranchPrefix(config);
  const propsForBranchPrefix = branchPrefix
    ? {
        UNSAFE_className: css({
          '& input': {
            paddingInlineStart: tokenSchema.size.space.xsmall,
          },
        }),
        startElement: (
          <Flex
            alignItems="center"
            paddingStart="regular"
            justifyContent="center"
            pointerEvents="none"
          >
            <Text color="neutralSecondary">{branchPrefix}</Text>
          </Flex>
        ),
      }
    : {};

  return (
    <Dialog>
      <form
        style={{ display: 'contents' }}
        onSubmit={async event => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          const fullBranchName = (branchPrefix ?? '') + branchName;
          const name = `refs/heads/${fullBranchName}`;
          const result = await createBranch({
            input: { name, oid: props.branchOid, repositoryId },
          });
          if (result.data?.createRef?.__typename) {
            props.onCreate(fullBranchName);
          }
        }}
      >
        <Heading>{stringFormatter.format('newBranch')}</Heading>
        <Content>
          <Flex gap="large" direction="column">
            <TextField
              value={branchName}
              onChange={setBranchName}
              label="Branch name"
              description={props.reason}
              autoFocus
              errorMessage={prettyErrorForCreateBranchMutation(error)}
              {...propsForBranchPrefix}
            />
          </Flex>
        </Content>
        <ButtonGroup>
          {isLoading && (
            <ProgressCircle
              isIndeterminate
              size="small"
              aria-label="Creating Branch"
            />
          )}
          <Button isDisabled={isLoading} onPress={props.onDismiss}>
            {stringFormatter.format('cancel')}
          </Button>
          <Button isDisabled={isLoading} prominence="high" type="submit">
            Create branch and save
          </Button>
        </ButtonGroup>
      </form>
    </Dialog>
  );
}

type ItemPageWrapperProps = {
  collection: string;
  itemSlug: string;
  config: Config;
  basePath: string;
};

function ItemPageWrapper(props: ItemPageWrapperProps) {
  const collectionConfig = props.config.collections?.[props.collection];
  if (!collectionConfig) notFound();
  const format = useMemo(
    () => getCollectionFormat(props.config, props.collection),
    [props.config, props.collection]
  );

  const slugInfo = useMemo(() => {
    return { slug: props.itemSlug, field: collectionConfig.slugField };
  }, [collectionConfig.slugField, props.itemSlug]);

  const itemDataConfig = {
    config: props.config,
    dirpath: getCollectionItemPath(
      props.config,
      props.collection,
      props.itemSlug
    ),
    schema: collectionConfig.schema,
    format,
    slug: slugInfo,
  };
  const itemData = useItemData(itemDataConfig);
  const committedItemData = useItemData(itemDataConfig, 'committed');

  const branchInfo = useBranchInfo();

  const key = `${branchInfo.currentBranch}/${props.collection}/item/${props.itemSlug}`;

  const yjsInfo = useYjsIfAvailable();

  const mapData = useData(
    useCallback(() => {
      if (!yjsInfo) return;
      if (yjsInfo === 'loading') return LOADING;
      return (async () => {
        await yjsInfo.doc.whenSynced;
        if (itemData.kind !== 'loaded') return LOADING;
        if (itemData.data === 'not-found') return;
        let doc = yjsInfo.data.get(key);
        if (doc instanceof Y.Doc) {
          const promise = doc.whenLoaded;
          doc.load();
          await promise;
        } else {
          doc = new Y.Doc();
          yjsInfo.data.set(key, doc);
        }
        const data = doc.getMap('data');
        if (!data.size) {
          const {
            data: { initialState },
          } = itemData;
          doc.transact(() => {
            for (const [key, value] of Object.entries(
              collectionConfig.schema
            )) {
              const val = getYjsValFromParsedValue(value, initialState[key]);
              data.set(key, val);
            }
          });
        }
        return data;
      })();
    }, [collectionConfig, itemData, key, yjsInfo])
  );

  if (itemData.kind === 'error') {
    return (
      <ItemPageShell {...props}>
        <PageBody>
          <Notice tone="critical">{itemData.error.message}</Notice>
        </PageBody>
      </ItemPageShell>
    );
  }
  if (committedItemData.kind === 'error') {
    return (
      <ItemPageShell {...props}>
        <PageBody>
          <Notice tone="critical">{committedItemData.error.message}</Notice>
        </PageBody>
      </ItemPageShell>
    );
  }
  if (mapData.kind === 'error') {
    return (
      <ItemPageShell {...props}>
        <PageBody>
          <Notice tone="critical">{mapData.error.message}</Notice>
        </PageBody>
      </ItemPageShell>
    );
  }
  if (
    itemData.kind === 'loading' ||
    mapData.kind === 'loading' ||
    committedItemData.kind === 'loading'
  ) {
    return (
      <ItemPageShell {...props}>
        <Flex
          alignItems="center"
          justifyContent="center"
          minHeight="scale.3000"
        >
          <ProgressCircle
            aria-label="Loading Item"
            isIndeterminate
            size="large"
          />
        </Flex>
      </ItemPageShell>
    );
  }

  if (itemData.data === 'not-found') {
    return (
      <ItemPageShell {...props}>
        <PageBody>
          <Notice tone="caution">Entry not found.</Notice>
        </PageBody>
      </ItemPageShell>
    );
  }
  const committedState =
    committedItemData.data === 'not-found'
      ? null
      : committedItemData.data.initialState;
  if (mapData.data) {
    return (
      <CollabItemPage
        collection={props.collection}
        basePath={props.basePath}
        config={props.config}
        itemSlug={props.itemSlug}
        initialState={itemData.data.initialState}
        initialFiles={itemData.data.initialFiles}
        localTreeKey={props.itemSlug}
        committedState={committedState}
        map={mapData.data}
      />
    );
  }
  return (
    <LocalItemPage
      collection={props.collection}
      basePath={props.basePath}
      config={props.config}
      itemSlug={props.itemSlug}
      initialState={itemData.data.initialState}
      initialFiles={itemData.data.initialFiles}
      localTreeKey={props.itemSlug}
      committedState={committedState}
    />
  );
}

const ItemPageShell = (
  props: ItemPageWrapperProps & {
    children: ReactNode;
    headerActions?: ReactNode;
  }
) => {
  const router = useRouter();
  const collectionConfig = props.config.collections![props.collection]!;

  return (
    <PageRoot containerWidth={containerWidthForEntryLayout(collectionConfig)}>
      <PageHeader>
        <Breadcrumbs
          flex
          size="medium"
          minWidth={0}
          onAction={key => {
            if (key === 'collection') {
              router.push(
                `${props.basePath}/collection/${encodeURIComponent(
                  props.collection
                )}`
              );
            }
          }}
        >
          <Item key="collection">{collectionConfig.label}</Item>
          <Item key="item">{props.itemSlug}</Item>
        </Breadcrumbs>
        {props.headerActions}
      </PageHeader>

      {props.children}
    </PageRoot>
  );
};

export { ItemPageWrapper as ItemPage };
