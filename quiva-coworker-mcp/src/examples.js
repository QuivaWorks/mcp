// Hand-written write payloads. Authored, not harvested: they show shape, not proof of live behaviour.

const EXAMPLES = {
  'org-memory': {
    tool: 'create_memory',
    teaches: 'A short standing fact every member\'s Abbie should know. Organisation scope needs confirm: true.',
    payload: { scope: 'organisation', memory: 'Month-end close finishes on the third working day.', topics: ['finance', 'deadlines'], confirm: true },
  },
  'personal-profile': {
    tool: 'update_personal_profile',
    teaches: 'Only the fields you pass change; the rest are kept from a fresh read.',
    payload: { how_i_work: 'Lead with the answer, then the detail. Bullet points over paragraphs.' },
  },
  correction: {
    tool: 'update_corrections',
    teaches: 'A correction is a situation and what to do instead. At most 6 per person.',
    payload: { add: [{ situation: 'When asked for a figure from a report', instead: 'Always check the source before quoting a figure, and name the source.' }] },
  },
  'org-profile': {
    tool: 'update_org_profile',
    teaches: 'Glossary entries teach Abbie internal acronyms. Admin-only, needs confirm: true.',
    payload: {
      glossary: [{ term: 'OKR', meaning: 'Objectives and key results, set each quarter.' }],
      systems_of_record: [{ system: 'The finance ledger', authoritative_for: 'invoices and payment status' }],
      confirm: true,
    },
  },
  'env-secret': {
    tool: 'set_env',
    teaches: 'A credential is always a SECRET:: reference, never the value itself.',
    payload: { scope: 'user', key: 'REPORTING_API_TOKEN', value: 'SECRET::reporting_api_token::', secret: true, description: 'Token for the internal reporting API.' },
  },
  'env-literal': {
    tool: 'set_env',
    teaches: 'Plain configuration is a literal, and Abbie can see it.',
    payload: { scope: 'organisation', key: 'REPORT_TIMEZONE', value: 'Europe/London', secret: false, description: 'Timezone for scheduled reports.', confirm: true },
  },
  'todo-resume': {
    tool: 'update_todo',
    teaches: 'Moving an item parked on a person back to pending resumes Abbie\'s work, so it needs confirm: true.',
    payload: { scope: 'user', id: '<todo id>', status: 'pending', confirm: true },
  },
};

export function listExamples() {
  return Object.entries(EXAMPLES).map(([slug, e]) => ({ slug, kind: 'authored', tool: e.tool, teaches: e.teaches }));
}

export function getExample(slug) {
  const e = EXAMPLES[slug];
  if (!e) return { error: `Unknown example "${slug}". Available: ${Object.keys(EXAMPLES).join(', ')}` };
  return { slug, kind: 'authored', ...e };
}

export { EXAMPLES };
