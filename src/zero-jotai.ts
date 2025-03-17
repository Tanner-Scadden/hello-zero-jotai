import { atom, getDefaultStore } from "jotai";
import { z } from "./zero";
import type {
  Change,
  Entry,
  Format,
  HumanReadable,
  Input,
  Output,
  Query,
  AdvancedQuery,
  ViewFactory,
  Node,
} from "@rocicorp/zero/advanced";
import { applyChange } from "@rocicorp/zero/advanced";
import type { Schema } from "./schema";
import debounce from "lodash/debounce";
import memoize from "lodash/memoize";
import type { QueryResultDetails } from "@rocicorp/zero/react";

type State = [Entry, QueryResultDetails];

// Define a type for the change operation
type ChangeOperation = "add" | "remove" | "edit";

/**
 * Subscriptions for the change factory.
 * This is used to subscribe to the changes of the query.
 * It is used in the zeroQueryAtom to create a new atom for the query.
 */
export type ChangeFactorySubscriptions<V> = {
  key: string;
  onData?: (result: [V[] | undefined, QueryResultDetails]) => void;
  onAdd?: (result: V) => void;
  onRemove?: (result: V) => void;
  onUpdate?: (result: V) => void;
};

/**
 * Keep track of all materialized factory views.
 * This is used to avoid subscribing to the same query multiple times for no reason.
 */
export const viewsMaterialized = new Map<
  string,
  ChangeListenerFactory<unknown>
>();

/**
 * Generate a unique key for the query + clientID of the user.
 */
export const getClientQueryKey = <
  TTable extends keyof Schema["tables"] & string,
  TReturn,
>(
  query: Query<Schema, TTable, TReturn>,
) => {
  return `${(query as AdvancedQuery<Schema, TTable, TReturn>).hash()}-${z.clientID}`;
};

/**
 * This is our implementation of syncing the Zero state to how we want to interact with it.
 * It handles subscribing to Zero's views, and consolidating changes through debouncing.
 * It also can take in subscriptions for `onData`, `onAdd`, `onRemove`, and `onUpdate`.
 * It is used in the zeroQueryAtom to create a new atom for the query.
 */
export class ChangeListenerFactory<V> implements Output {
  readonly #input: Input;
  readonly #format: Format;
  readonly #onDestroy: () => void;
  readonly #refCountMap = new WeakMap<Entry, number>();

  #state: State;

  // Single queue map for all operations, keyed by operation type and node ID
  #consolidatedCallbacks = new Map<string, V>();
  #handleConsolidatedDebounced: ReturnType<typeof debounce>;

  /**
   * Keep track of all subscriptions for the query.
   * This is used to avoid subscribing to the same query multiple times for no reason.
   * This is why you must have a unique key for each subscription.
   */
  #subscriptions = new Map<string, ChangeFactorySubscriptions<V>>();

  // A lot of this is taken from the Zero library implementations for Svelte, Solid, and Vue.
  constructor(
    input: Input,
    onTransactionCommit: (cb: () => void) => void,
    // biome-ignore lint:
    format: Format = { singular: false, relationships: {} },
    // biome-ignore lint:
    onDestroy: () => void = () => {},
    queryComplete: true | Promise<true>,
    subscriptions: ChangeFactorySubscriptions<V>,
  ) {
    this.#input = input;
    this.#format = format;
    this.#onDestroy = onDestroy;
    this.#state = [
      { "": format.singular ? undefined : [] },
      { type: queryComplete === true ? "complete" : "unknown" },
    ];
    input.setOutput(this);

    this.#subscriptions.set(subscriptions.key, subscriptions);

    for (const node of input.fetch({})) {
      this.#applyChange({ type: "add", node });
    }

    if (queryComplete !== true) {
      void queryComplete.then(() => {
        this.#state[1] = { type: "complete" };
      });
    }

    // Debounce the consolidated changes to avoid excessive re-renders or wasting compute.
    this.#handleConsolidatedDebounced = debounce(
      this.#handleConsolidated,
      100,
      { leading: false, trailing: true },
    );
  }

  get data() {
    return this.#state[0][""] as V[];
  }

  get status() {
    return this.#state[1].type;
  }

  /**
   * Handles calling all the callbacks for the subscriptions for the `onData` subscription.
   */
  #onData() {
    for (const callbacks of this.#subscriptions.values()) {
      callbacks.onData?.([this.data, { type: this.status }]);
    }
  }

  // Methods for managing subscriptions and checking the state of the private values.
  hasSubscribers() {
    return !!this.#subscriptions.size;
  }

  addSubscriptions(opts: ChangeFactorySubscriptions<V>) {
    this.#subscriptions.set(opts.key, opts);
  }

  removeSubscriptions(key: string) {
    this.#subscriptions.delete(key);
  }

  destroy() {
    try {
      // Cancel all pending functions
      this.#consolidatedCallbacks.clear();
      this.#subscriptions.clear();

      this.#onDestroy();
    } catch (e) {
      // Sometimes zero has already cleaned up the view, so we need to handle
      // the error for that case.
      if (e instanceof Error && e.message.includes("Connection not found")) {
        return;
      }
      throw e;
    }
  }

  #applyChange(change: Change): void {
    applyChange(
      this.#state[0],
      change,
      this.#input.getSchema(),
      "",
      this.#format,
      this.#refCountMap,
    );
    this.#onData();
  }

  // Helper to get a node ID or generate a fallback
  #getNodeId(node: Node): string {
    // Try to get an ID from the node's row
    const row = node.row as Record<string, unknown>;
    const id = row.id || row.ID;
    return id ? String(id) : JSON.stringify(row);
  }

  #createDebounceKey(type: ChangeOperation, nodeId: string): string {
    return `${type}-${nodeId}`;
  }

  #decriptDebounceKey(debounceKey: string) {
    const [type] = debounceKey.split("-");
    return type as ChangeOperation;
  }

  #typeToFunctionKey(type: ChangeOperation) {
    switch (type) {
      case "add":
        return "onAdd";
      case "remove":
        return "onRemove";
      case "edit":
        return "onUpdate";
    }
  }

  #handleConsolidated() {
    for (const [debounceKey, data] of this.#consolidatedCallbacks.entries()) {
      const type = this.#decriptDebounceKey(debounceKey);
      const functionKey = this.#typeToFunctionKey(type);

      for (const callbacks of this.#subscriptions.values()) {
        if (callbacks[functionKey]) {
          callbacks[functionKey](data);
        }
      }
    }
    this.#consolidatedCallbacks.clear();
  }

  // Process a change with debouncing
  #consolidateChanges(
    changeType: ChangeOperation,
    nodeId: string,
    data: V,
  ): void {
    const debounceKey = this.#createDebounceKey(changeType, nodeId);
    this.#consolidatedCallbacks.set(debounceKey, data);
    this.#handleConsolidatedDebounced();
  }

  push(change: Change): void {
    this.#applyChange(change);

    const nodeId = this.#getNodeId(change.node);

    if (change.type === "child") {
      return;
    }

    this.#consolidateChanges(change.type, nodeId, change.node.row as V);
  }
}

/**
 * This comes from the Zero library implementations for Svelte, Solid, and Vue.
 */
export function zeroChangeListenerFactoryInternal<
  TSchema extends Schema,
  TTable extends keyof TSchema["tables"] & string,
  TReturn,
>(
  _query: Query<TSchema, TTable, TReturn>,
  input: Input,
  format: Format,
  onDestroy: () => void,
  onTransactionCommit: (cb: () => void) => void,
  queryComplete: true | Promise<true>,
) {
  return new ChangeListenerFactory<HumanReadable<TReturn>>(
    input,
    onTransactionCommit,
    format,
    onDestroy,
    queryComplete,
    {
      key: "a",
    },
  );
}

zeroChangeListenerFactoryInternal satisfies ViewFactory<
  Schema,
  keyof Schema["tables"],
  unknown,
  unknown
>;

export function zeroChangeListenerFactory<
  TSchema extends Schema,
  TTable extends keyof TSchema["tables"] & string,
  TReturn,
>(opts: ChangeFactorySubscriptions<HumanReadable<TReturn>>) {
  return function factory(
    _query: Query<TSchema, TTable, TReturn>,
    input: Input,
    format: Format,
    onDestroy: () => void,
    onTransactionCommit: (cb: () => void) => void,
    queryComplete: true | Promise<true>,
  ) {
    return new ChangeListenerFactory<HumanReadable<TReturn>>(
      input,
      onTransactionCommit,
      format,
      onDestroy,
      queryComplete,
      opts,
    );
  };
}

/**
 * Materializes a factory view, and keeps track of it in the map to return existing views.
 * Views are subscriptions in Zero, and we want to avoid subscribing to the same query multiple times for no reason.
 */
const getMaterializedFactoryView = <
  TTable extends keyof Schema["tables"] & string,
  TReturn,
>({
  query,
  subscriptions,
}: {
  query: Query<Schema, TTable, TReturn>;
  subscriptions: ChangeFactorySubscriptions<TReturn>;
}) => {
  const key = getClientQueryKey(query);
  let view = viewsMaterialized.get(key) as
    | ChangeListenerFactory<TReturn>
    | undefined;
  if (view) {
    view.addSubscriptions(subscriptions);
    return view as ChangeListenerFactory<TReturn>;
  }
  // @ts-ignore
  view = query.materialize(zeroChangeListenerFactory(subscriptions));
  // @ts-ignore
  viewsMaterialized.set(key, view);
  return view as ChangeListenerFactory<TReturn>;
};

/**
 * Cleans up a materialized factory view.
 * Removes any subscriptions, and if there are no more subscriptions, destroys the view.
 */
const cleanupMaterializedFactoryView = ({
  queryKey,
  subscriptionKey,
}: {
  queryKey: string;
  subscriptionKey: string;
}) => {
  const view = viewsMaterialized.get(queryKey);
  if (!view) return;

  view.removeSubscriptions(subscriptionKey);
  if (view.hasSubscribers()) return;

  view.destroy();
  viewsMaterialized.delete(queryKey);
};

/**
 * Atom that handles syncing zero's state to an atom. It is memoized to ensure the same atom is returned for the same user and query.
 * Should probably not be used directly, but rather through useZeroQueryAtom.
 * As you want the cleanup to be handled by the hook, and this atom does not handle cleanup.
 */
export const zeroQueryAtom = memoize(
  <TTable extends keyof Schema["tables"] & string, TReturn>({
    query,
    subscriptions,
    store = getDefaultStore(),
    syncOnData = true,
  }: {
    query: Query<Schema, TTable, TReturn>;
    subscriptions: Omit<ChangeFactorySubscriptions<TReturn>, "onData">;
    store: ReturnType<typeof getDefaultStore>;
    syncOnData?: boolean;
  }) => {
    const stateAtom = atom(
      (): [TReturn[], QueryResultDetails] => {
        if (!materializedFactoryView) {
          return [[], { type: "unknown" }];
        }

        return [
          // Use structuredClone so react re-renders and to avoid reference issues.
          structuredClone(materializedFactoryView.data ?? []),
          { type: materializedFactoryView.status },
        ];
      },
      (_, set, value: [TReturn[], QueryResultDetails]) => {
        set(stateAtom, value);
      }
    );

    const materializedFactoryView = getMaterializedFactoryView<TTable, TReturn>(
      {
        query,
        subscriptions: {
          ...subscriptions,
          onData(result) {
            if (!syncOnData) {
              return;
            }

            // Use structuredClone so react re-renders and to avoid reference issues.
            store.set(stateAtom, [structuredClone(result[0] ?? []), result[1]]);
          },
        },
      },
    );
    stateAtom.debugLabel = `${subscriptions.key} State Atom`;

    return {
      stateAtom,
      queryKey: getClientQueryKey(query),
      cleanup: (queryKey: string) =>
        cleanupMaterializedFactoryView({
          queryKey,
          subscriptionKey: subscriptions.key,
        }),
    };
  },
  ({ query }) => getClientQueryKey(query),
);