import { useLocalizedStringFormatter } from '@react-aria/i18n';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@keystar/ui/button';
import { Breadcrumbs, Item } from '@keystar/ui/breadcrumbs';
import { Flex } from '@keystar/ui/layout';
import { Notice } from '@keystar/ui/notice';
import { ProgressCircle } from '@keystar/ui/progress';
import { toastQueue } from '@keystar/ui/toast';

import { Config } from '../config';
import { fields } from '../form/api';
import { getInitialPropsValue } from '../form/initial-values';
import { clientSideValidateProp } from '../form/errors';
import { useEventCallback } from '../form/fields/document/DocumentEditor/ui-utils';
import {
  getCollectionFormat,
  getCollectionItemPath,
  getPathPrefix,
  getSlugFromState,
} from './utils';

import l10nMessages from './l10n/index.json';
import { useRouter } from './router';
import { PageRoot, PageHeader, PageBody } from './shell/page';
import { useBranchInfo, useCurrentUnscopedTree } from './shell/data';
import { serializeEntryToFiles, useUpsertItem } from './updating';
import { FormForEntry, containerWidthForEntryLayout } from './entry-form';
import { notFound } from './not-found';
import { parseEntry, useItemData } from './useItemData';
import { useSlugFieldInfo } from './slugs';
import { z } from 'zod';
import {
  delDraft,
  getDraft,
  setDraft,
  showDraftRestoredToast,
} from './persistence';
import { useHasChanged } from './useHasChanged';
import { LOADING, useData } from './useData';
import { Tooltip, TooltipTrigger } from '@keystar/ui/tooltip';
import { Icon } from '@keystar/ui/icon';
import { historyIcon } from '@keystar/ui/icon/icons/historyIcon';
import * as Y from 'yjs';
import { getYjsValFromParsedValue } from '../form/props-value';
import { createGetPreviewPropsFromY } from '../form/preview-props-yjs';
import { useYjs, useYjsIfAvailable } from './shell/collab';
import { PresenceAvatars } from './presence';
import { useConfig } from './shell/context';
import { createGetPreviewProps } from '../form/preview-props';
import { useYJsValue } from './useYJsValue';
import { useExtraRoots, writeChangesToLocalObjectStore } from './object-store';

function CreateItemWrapper(props: {
  collection: string;
  config: Config;
  basePath: string;
}) {
  const router = useRouter();
  const duplicateSlug = useMemo(() => {
    const url = new URL(router.href, 'http://localhost');
    return url.searchParams.get('duplicate');
  }, [router.href]);

  const collectionConfig = props.config.collections?.[props.collection];
  if (!collectionConfig) notFound();
  const format = useMemo(
    () => getCollectionFormat(props.config, props.collection),
    [props.config, props.collection]
  );

  const draftData = useData(
    useCallback(async () => {
      const raw = await getDraft([
        'collection-create',
        props.collection,
        ...(duplicateSlug ? ([duplicateSlug] as const) : ([] as const)),
      ]);
      if (!raw) throw new Error('No draft found');
      const stored = storedValSchema.parse(raw);
      const parsed = parseEntry(
        {
          config: props.config,
          dirpath: getCollectionItemPath(
            props.config,
            props.collection,
            stored.slug
          ),
          format,
          schema: collectionConfig.schema,
          slug: { field: collectionConfig.slugField, slug: stored.slug },
        },
        stored.files
      );
      return { state: parsed.initialState, savedAt: stored.savedAt };
    }, [
      collectionConfig,
      duplicateSlug,
      format,
      props.collection,
      props.config,
    ])
  );

  const slug = useMemo(() => {
    if (duplicateSlug) {
      return { field: collectionConfig.slugField, slug: duplicateSlug };
    }
    if (collectionConfig.template) {
      return { field: collectionConfig.slugField, slug: '' };
    }
  }, [duplicateSlug, collectionConfig]);

  const isFromTemplate = !!duplicateSlug || !!collectionConfig.template;

  const itemData = useItemData({
    config: props.config,
    dirpath:
      collectionConfig.template && !duplicateSlug
        ? collectionConfig.template
        : getCollectionItemPath(
            props.config,
            props.collection,
            duplicateSlug ?? ''
          ),
    schema: collectionConfig.schema,
    format,
    slug,
  });

  const duplicateInitalState =
    isFromTemplate &&
    itemData.kind === 'loaded' &&
    itemData.data !== 'not-found'
      ? itemData.data.initialState
      : undefined;

  const duplicateInitalStateWithUpdatedSlug = useMemo(() => {
    if (duplicateInitalState) {
      let slugFieldValue = duplicateInitalState[collectionConfig.slugField];
      // we'll make a best effort to add something to the slug after duplicated so it's different
      // but if it fails a user can change it before creating
      // (e.g. potentially it's not just a text field so appending -copy might not work)
      try {
        const slugFieldSchema =
          collectionConfig.schema[collectionConfig.slugField];
        if (
          slugFieldSchema.kind !== 'form' ||
          slugFieldSchema.formKind !== 'slug'
        ) {
          throw new Error('not slug field');
        }
        const serialized = slugFieldSchema.serializeWithSlug(slugFieldValue);
        slugFieldValue = slugFieldSchema.parse(serialized.value, {
          slug: serialized.slug ? `${serialized.slug}-copy` : '',
        });
      } catch {}
      return {
        ...duplicateInitalState,
        [collectionConfig.slugField]: slugFieldValue,
      };
    }
  }, [
    collectionConfig.schema,
    collectionConfig.slugField,
    duplicateInitalState,
  ]);

  const branchInfo = useBranchInfo();
  const yjsInfo = useYjsIfAvailable();
  const key = `${branchInfo.currentBranch}/${props.collection}/create${
    duplicateSlug?.length ? `?duplicate=${duplicateSlug}` : ''
  }`;

  const mapData = useData(
    useCallback(async () => {
      if (!yjsInfo) return;
      if (yjsInfo === 'loading') return LOADING;
      await yjsInfo.doc.whenSynced;
      if (isFromTemplate && !duplicateInitalState) return LOADING;
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
        doc.transact(() => {
          for (const [key, value] of Object.entries(collectionConfig.schema)) {
            const val = getYjsValFromParsedValue(
              value,
              duplicateInitalState?.[key] ?? getInitialPropsValue(value)
            );
            data.set(key, val);
          }
        });
      }
      return data;
    }, [collectionConfig, duplicateInitalState, isFromTemplate, key, yjsInfo])
  );

  if (isFromTemplate && itemData.kind === 'error') {
    return (
      <PageBody>
        <Notice tone="critical">{itemData.error.message}</Notice>
      </PageBody>
    );
  }
  if (mapData.kind === 'error') {
    console.log(mapData.error);
    return (
      <PageBody>
        <Notice tone="critical">{mapData.error.message}</Notice>
      </PageBody>
    );
  }
  if (
    (isFromTemplate && itemData.kind === 'loading') ||
    draftData.kind === 'loading' ||
    mapData.kind === 'loading'
  ) {
    return (
      <Flex alignItems="center" justifyContent="center" minHeight="scale.3000">
        <ProgressCircle
          aria-label="Loading Item"
          isIndeterminate
          size="large"
        />
      </Flex>
    );
  }
  if (
    isFromTemplate &&
    itemData.kind === 'loaded' &&
    itemData.data === 'not-found'
  ) {
    return (
      <PageBody>
        <Notice tone="caution">Entry not found.</Notice>
      </PageBody>
    );
  }

  if (!mapData.data) {
    return (
      <CreateItemLocal
        collection={props.collection}
        config={props.config}
        basePath={props.basePath}
        draft={draftData.kind === 'loaded' ? draftData.data : undefined}
        duplicateSlug={duplicateSlug}
        initialState={duplicateInitalStateWithUpdatedSlug}
      />
    );
  }
  return (
    <CreateItemCollab
      collection={props.collection}
      config={props.config}
      basePath={props.basePath}
      duplicateSlug={duplicateSlug}
      initialState={duplicateInitalStateWithUpdatedSlug}
      map={mapData.data}
    />
  );
}

const storedValSchema = z.object({
  version: z.literal(1),
  savedAt: z.date(),
  slug: z.string(),
  files: z.map(z.string(), z.instanceof(Uint8Array)),
});

function CreateItemLocal(props: {
  collection: string;
  config: Config;
  basePath: string;
  duplicateSlug: string | null;
  draft: { state: Record<string, unknown>; savedAt: Date } | undefined;
  initialState: Record<string, unknown> | undefined;
}) {
  const collectionConfig = props.config.collections?.[props.collection];
  if (!collectionConfig) notFound();
  const schema = useMemo(
    () => fields.object(collectionConfig.schema),
    [collectionConfig.schema]
  );
  const initialState = useMemo(() => {
    return props.initialState ?? getInitialPropsValue(schema);
  }, [props.initialState, schema]);
  const [state, setState] = useState(props.draft?.state ?? initialState);

  const previewProps = useMemo(
    () => createGetPreviewProps(schema, setState, () => undefined),
    [schema]
  )(state);

  useEffect(() => {
    if (props.draft && state === props.draft.state) {
      showDraftRestoredToast(props.draft.savedAt, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.draft]);

  const slug = getSlugFromState(collectionConfig, state);

  const formatInfo = getCollectionFormat(props.config, props.collection);

  const basePath = getCollectionItemPath(props.config, props.collection, slug);

  const [isCreating, setIsCreating] = useState(false);

  const branchInfo = useBranchInfo();
  const extraRoots = useExtraRoots();
  const unscopedTree = useCurrentUnscopedTree();

  const createItem = useEventCallback(async () => {
    if (isCreating || unscopedTree.kind !== 'loaded') return false;
    setIsCreating(true);
    const pathPrefix = getPathPrefix(props.config.storage) || '';
    const additions = serializeEntryToFiles({
      basePath,
      config: props.config,
      format: formatInfo,
      schema: collectionConfig.schema,
      slug: { field: collectionConfig.slugField, value: slug },
      state,
    }).map(({ path, contents }) => ({ path: pathPrefix + path, contents }));

    await writeChangesToLocalObjectStore({
      additions,
      currentBranch: branchInfo.currentBranch,
      extraRoots,
      initialFiles: [],
      unscopedTree: unscopedTree.data.tree,
    });
    return true;
  });

  const hasChanged = useHasChanged({
    initialState,
    schema,
    state,
    slugField: collectionConfig.slugField,
  });

  useEffect(() => {
    const key = [
      'collection-create',
      props.collection,
      ...(props.duplicateSlug
        ? ([props.duplicateSlug] as const)
        : ([] as const)),
    ] as const;
    if (hasChanged && !isCreating) {
      const serialized = serializeEntryToFiles({
        basePath,
        config: props.config,
        format: formatInfo,
        schema: collectionConfig.schema,
        slug: { field: collectionConfig.slugField, value: slug },
        state,
      });
      const files = new Map(serialized.map(x => [x.path, x.contents]));
      const data: z.infer<typeof storedValSchema> = {
        slug,
        files,
        savedAt: new Date(),
        version: 1,
      };
      setDraft(key, data);
    } else {
      delDraft(key);
    }
  }, [
    collectionConfig,
    slug,
    state,
    hasChanged,
    props.duplicateSlug,
    props.collection,
    props.config,
    basePath,
    formatInfo,
    isCreating,
  ]);
  return (
    <CreateItemInner
      basePath={props.basePath}
      isCreating={isCreating}
      collection={props.collection}
      createItem={createItem}
      state={state}
      slug={slug}
      previewProps={previewProps}
      onReset={() => {
        setState(initialState);
      }}
    />
  );
}

function CreateItemCollab(props: {
  collection: string;
  config: Config;
  basePath: string;
  duplicateSlug: string | null;
  initialState: Record<string, unknown> | undefined;
  map: Y.Map<unknown>;
}) {
  const collectionConfig = props.config.collections?.[props.collection];
  if (!collectionConfig) notFound();
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

  const slug = getSlugFromState(collectionConfig, state);

  const formatInfo = getCollectionFormat(props.config, props.collection);

  const basePath = getCollectionItemPath(props.config, props.collection, slug);
  const [createResult, _createItem] = useUpsertItem({
    state,
    basePath,
    initialFiles: undefined,
    config: props.config,
    schema: collectionConfig.schema,
    format: formatInfo,
    currentLocalTreeKey: undefined,
    slug: { field: collectionConfig.slugField, value: slug },
  });
  const createItem = useEventCallback(_createItem);

  return (
    <CreateItemInner
      basePath={props.basePath}
      collection={props.collection}
      isCreating={
        createResult.kind === 'loading' || createResult.kind === 'updated'
      }
      createItem={createItem}
      state={state}
      slug={slug}
      previewProps={previewProps}
      onReset={() => {
        props.map.doc!.transact(() => {
          for (const [key, value] of Object.entries(collectionConfig.schema)) {
            const val = getYjsValFromParsedValue(
              value,
              props.initialState?.[key] ?? getInitialPropsValue(value)
            );
            props.map.set(key, val);
          }
        });
      }}
    />
  );
}

function CreateItemInner(props: {
  basePath: string;
  collection: string;
  isCreating: boolean;
  createItem: ReturnType<typeof useUpsertItem>[1];
  state: Record<string, unknown>;
  slug: string;
  previewProps: ReturnType<typeof createGetPreviewPropsFromY>;
  onReset: () => void;
}) {
  const stringFormatter = useLocalizedStringFormatter(l10nMessages);
  const router = useRouter();
  const config = useConfig();
  const collectionConfig = config.collections![props.collection];

  const schema = useMemo(
    () => fields.object(collectionConfig.schema),
    [collectionConfig]
  );

  const [forceValidation, setForceValidation] = useState(false);
  const formatInfo = getCollectionFormat(config, props.collection);

  let collectionPath = `${props.basePath}/collection/${encodeURIComponent(
    props.collection
  )}`;

  const currentSlug = props.isCreating ? props.slug : undefined;
  const slugInfo = useSlugFieldInfo(props.collection, currentSlug);

  const onCreate = async () => {
    if (props.isCreating) return;
    if (!clientSideValidateProp(schema, props.state, slugInfo)) {
      setForceValidation(true);
      return;
    }
    if (await props.createItem()) {
      const slug = getSlugFromState(collectionConfig, props.state);
      router.push(`${collectionPath}/item/${encodeURIComponent(slug)}`);
      toastQueue.positive('Entry created', { timeout: 5000 }); // TODO: l10n
    }
  };

  const formID = 'item-create-form';

  return (
    <>
      <PageRoot containerWidth={containerWidthForEntryLayout(collectionConfig)}>
        <PageHeader>
          <Breadcrumbs
            size="medium"
            flex
            minWidth={0}
            onAction={key => {
              if (key === 'collection') {
                router.push(collectionPath);
              }
            }}
          >
            <Item key="collection">{collectionConfig.label}</Item>
            <Item key="current">{stringFormatter.format('add')}</Item>
          </Breadcrumbs>
          <PresenceAvatars />
          {props.isCreating && (
            <ProgressCircle
              aria-label="Creating entry"
              isIndeterminate
              size="small"
            />
          )}
          <TooltipTrigger>
            <Button
              prominence="low"
              aria-label="Reset"
              onPress={() => {
                props.onReset();
                setForceValidation(false);
              }}
            >
              <Icon src={historyIcon} />
            </Button>
            <Tooltip>Reset</Tooltip>
          </TooltipTrigger>
          <Button
            isDisabled={props.isCreating}
            prominence="high"
            type="submit"
            form={formID}
            marginStart="auto"
          >
            {stringFormatter.format('create')}
          </Button>
        </PageHeader>
        <Flex
          id={formID}
          elementType="form"
          onSubmit={event => {
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            onCreate();
          }}
          direction="column"
          gap="xxlarge"
          height="100%"
          minHeight={0}
          minWidth={0}
        >
          <FormForEntry
            previewProps={props.previewProps}
            forceValidation={forceValidation}
            entryLayout={collectionConfig.entryLayout}
            formatInfo={formatInfo}
            slugField={slugInfo}
          />
        </Flex>
      </PageRoot>
    </>
  );
}

export { CreateItemWrapper as CreateItem };
