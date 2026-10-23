import examples from "../../src/api/fixtures/examples.json";

export function example<T = any>(name: keyof typeof examples): T {
  return structuredClone(examples[name].payload) as T;
}
