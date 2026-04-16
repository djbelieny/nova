// Bot identity — exported for use wherever the AI refers to itself by name.
// Override with NOVA_NAME env var to white-label the assistant.
export const NOVA_NAME = process.env.NOVA_NAME ?? "Nova";
