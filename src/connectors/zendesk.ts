import { httpJson, type Connector } from './types';

const base = (ctx: any) => `https://${ctx.creds.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
const auth = (ctx: any) => ({ Authorization: `Basic ${Buffer.from(`${ctx.creds.ZENDESK_EMAIL}/token:${ctx.creds.ZENDESK_TOKEN}`).toString('base64')}` });

export const zendeskConnector: Connector = {
  id: 'zendesk',
  label: 'Zendesk (support)',
  authKind: 'basic',
  credEnv: ['ZENDESK_SUBDOMAIN', 'ZENDESK_EMAIL', 'ZENDESK_TOKEN'],
  actions: {
    list_tickets: {
      description: 'List recent tickets. input: {}',
      run: (_input, ctx) => httpJson(ctx, 'GET', `${base(ctx)}/tickets.json?sort_order=desc`, { headers: auth(ctx) }),
    },
    create_ticket: {
      description: 'Create a ticket. input: { subject, body, priority? }',
      write: true,
      run: (input, ctx) => httpJson(ctx, 'POST', `${base(ctx)}/tickets.json`, { headers: auth(ctx), body: { ticket: { subject: input.subject, comment: { body: input.body }, priority: input.priority } } }),
    },
  },
  triggers: [{
    event: 'zendesk.ticket',
    description: 'New tickets',
    poll: async (ctx) => {
      const r = await httpJson(ctx, 'GET', `${base(ctx)}/tickets.json?sort_order=desc`, { headers: auth(ctx) });
      return r?.tickets || [];
    },
  }],
};
