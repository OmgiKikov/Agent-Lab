import { userSimulatorAgent } from "@langwatch/scenario";
import { parseCustomerContract, ScriptedCustomer } from "./customer-contract";
/** Optional native parameter: ordinary scenarios keep the existing SDK simulator. */
export function createCustomerAdapter(
  model: any,
  parameters: Record<string, unknown>,
) {
  const adapter = userSimulatorAgent({ model });
  const contract = parseCustomerContract(parameters.customer_contract);
  if (!contract) return adapter;
  const state = new ScriptedCustomer(contract);
  adapter.name = "ScriptedCustomer";
  adapter.call = async (input: any) => {
    const last = [...(input.messages ?? [])]
      .reverse()
      .find((m: any) => m.role === "assistant");
    const text =
      typeof last?.content === "string"
        ? last.content
        : Array.isArray(last?.content)
          ? last.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n")
          : "";
    return { role: "user" as const, content: state.next(text) };
  };
  return adapter;
}
