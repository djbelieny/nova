import { httpJson, type Connector } from './types';

const BASE = 'https://api.hubapi.com';
const auth = (ctx: any) => ({ Authorization: `Bearer ${ctx.creds.HUBSPOT_TOKEN}` });

export const hubspotConnector: Connector = {
  id: 'hubspot',
  label: 'HubSpot (CRM)',
  authKind: 'api_key',
  credEnv: ['HUBSPOT_TOKEN'],
  actions: {
    list_contacts: {
      description: 'List contacts. input: { limit? }',
      run: (input, ctx) => httpJson(ctx, 'GET', `${BASE}/crm/v3/objects/contacts?limit=${input.limit || 20}`, { headers: auth(ctx) }),
    },
    create_contact: {
      description: 'Create a contact. input: { email, firstname?, lastname?, ... }',
      write: true,
      run: (input, ctx) => httpJson(ctx, 'POST', `${BASE}/crm/v3/objects/contacts`, { headers: auth(ctx), body: { properties: input } }),
    },
  },
  triggers: [{
    event: 'hubspot.contact',
    description: 'Recently created contacts',
    poll: async (ctx) => {
      const r = await httpJson(ctx, 'GET', `${BASE}/crm/v3/objects/contacts?limit=10&sort=-createdate`, { headers: auth(ctx) });
      return r?.results || [];
    },
  }],
};
