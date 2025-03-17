import { useEffect } from "react";

import { useAtomValue, useStore } from "jotai";
import { Schema } from "./schema";
import { Query } from "@rocicorp/zero";
import { ChangeFactorySubscriptions, zeroQueryAtom } from "./zero-jotai";
import { useRef } from "react";

/**
 * Use this to subscribe to a query and get the result.
 * Atom's value will be updated when ever the query result changes.
 * Key is important to ensure that your subscriptions are unique and will be called, but are also able to be cleaned up when the component unmounts.
 * @example
 * const [result, { type }] = useZeroQueryAtom(
 *  ADMIN_UNIT_INFO_QUERY(z, { unitId: (id ? +id : units[0]?.id) || 0 }),
 *  {
 *    key: "admin-unit-info",
 *    onAdd(result) {
 *      console.log("ADD", result);
 *    },
 *    onRemove(result) {
 *      console.log("REMOVE", result);
 *    },
 *    onUpdate(result) {
 *      console.log("UPDATE", result);
 *    },
 *  },
 * );
 */
export const useZeroQueryAtom = <
  TTable extends keyof Schema["tables"] & string,
  TReturn,
>(
  query: Query<Schema, TTable, TReturn>,
  subscriptions: ChangeFactorySubscriptions<TReturn>,
) => {
  const store = useStore();
  const { stateAtom, cleanup, queryKey } = zeroQueryAtom({
    query,
    subscriptions,
    store,
  });

  // This is to ensure that the previous query is cleaned up when the component unmounts, or the query changes.
  // If we didn't call this, the previous query would stay subscribed to, and we'd have a memory leak, and excessive data fetching.
  const previousQueryKey = useRef(queryKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: <Want to only run cleanup on queryKey change>
  useEffect(() => {
    if (previousQueryKey.current !== queryKey) {
      cleanup(previousQueryKey.current);
      previousQueryKey.current = queryKey;
    }
  }, [queryKey]);

  return useAtomValue(stateAtom);
};