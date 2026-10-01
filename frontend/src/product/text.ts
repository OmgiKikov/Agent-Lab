/** A chat button the agent sent, written into the logged text as «` ` ` transition-code CODE ` ` `». */
const CONTROL = /`\s*`\s*`\s*transition-code\s*([A-Za-z0-9_-]*)\s*`\s*`\s*`/g;

/** The words the customer saw, and the buttons the agent sent with them. */
export function visible(text: string): { text: string; buttons: string[] } {
  const buttons: string[] = [];
  const clean = text
    .replace(CONTROL, (_, code: string) => {
      buttons.push(code);
      return "";
    })
    .trim();
  return { text: clean, buttons };
}

/** «src/aigw_service/chain/main_idp.py:212» → «chain/main_idp.py:212»: the folder and the file are enough to recognise it. */
export function shortOrigin(origin: string) {
  const parts = origin.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : origin;
}
