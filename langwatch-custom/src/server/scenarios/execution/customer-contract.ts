export type CustomerContract = {
  mode: "scripted";
  opening: string;
  followup: string;
  facts: {
    aliases: string[];
    value: string | null;
    disclose: "after_question" | "opening";
  }[];
  maxCustomerTurns: number;
};
export function parseCustomerContract(value: unknown): CustomerContract | null {
  if (value == null || value === "") return null;
  const data = typeof value === "string" ? JSON.parse(value) : (value as any);
  if (
    data.mode !== "scripted" ||
    typeof data.opening !== "string" ||
    !data.opening.trim() ||
    typeof data.followup !== "string" ||
    !Array.isArray(data.facts) ||
    !Number.isInteger(data.maxCustomerTurns) ||
    data.maxCustomerTurns < 1 ||
    data.maxCustomerTurns > 12
  )
    throw new Error("Invalid customer contract");
  for (const fact of data.facts) {
    if (
      !Array.isArray(fact.aliases) ||
      !fact.aliases.every(
        (a: unknown) => typeof a === "string" && a.length > 0,
      ) ||
      !(fact.value === null || typeof fact.value === "string") ||
      !["after_question", "opening"].includes(fact.disclose)
    )
      throw new Error("Invalid customer fact");
  }
  return data;
}
/** No model, evaluator criterion, golden answer or agent-offered ID becomes a customer fact. */
export class ScriptedCustomer {
  private turn = 0;
  private readonly contract: CustomerContract;
  constructor(contract: CustomerContract) {
    this.contract = contract;
  }
  next(agentText: string): string {
    if (this.turn >= this.contract.maxCustomerTurns)
      throw Object.assign(new Error("Customer dialogue budget exceeded"), {
        code: "CUSTOMER_CONTRACT_INVALID",
      });
    this.turn++;
    if (this.turn === 1) {
      const upfront = this.contract.facts
        .filter((f) => f.disclose === "opening" && f.value !== null)
        .map((f) => f.value);
      return [this.contract.opening, ...upfront].join(" ");
    }
    const normalized = agentText.normalize("NFKC").toLocaleLowerCase("ru");
    const asks =
      /\?|укажите|назовите|напишите|какой|provide|tell me|what is/i.test(
        normalized,
      );
    if (asks) {
      for (const fact of this.contract.facts) {
        if (
          !fact.aliases.some((a) =>
            normalized.includes(a.toLocaleLowerCase("ru")),
          )
        )
          continue;
        return fact.value === null
          ? "Не знаю этих сведений. " + this.contract.followup
          : fact.value;
      }
    }
    return this.contract.followup;
  }
}
