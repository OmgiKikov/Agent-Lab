import { useQuery } from "@tanstack/react-query";
import { fetchPrices, hasFetchedPrices } from "../utils/costs";

export function useModelPrices() {
  const query = useQuery({
    queryKey: ["model-prices"],
    queryFn: async () => {
      await fetchPrices();
      return hasFetchedPrices();
    },
    staleTime: 60 * 60 * 1000,
  });

  return {
    ...query,
    hasFetchedPrices: query.data ?? hasFetchedPrices(),
  };
}
