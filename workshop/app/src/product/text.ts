/** «src/aigw_service/chain/main_idp.py:212» → «chain/main_idp.py:212»: the folder and the file are enough to recognise it. */
export function shortOrigin(origin: string) {
  const parts = origin.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : origin;
}
