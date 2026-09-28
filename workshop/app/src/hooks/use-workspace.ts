import { useQuery } from "@tanstack/react-query";
import { getActiveWorkspace } from "../api/workspace";

export function useActiveWorkspace() {
  return useQuery({
    queryKey: ["active-workspace"],
    queryFn: getActiveWorkspace,
  });
}
