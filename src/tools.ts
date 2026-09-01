// Tool definitions, Zod validation, and execute functions for all 9 BriefGate MCP tools.
// TOOLS is the JSON-schema array sent to the MCP client in ListTools.
// executeTool dispatches CallTool requests to typed execute functions.

import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  type BriefGateConfig,
  createIntake,
  listIntakes,
  getIntakeStatus,
  getIntakeResults,
  addItems,
  updateItem,
  requestRevision,
  sendChase,
  listWebhooks,
  createWebhook,
  deleteWebhook,
} from './client.js';

// ─── Shared Zod schemas (exported for testing) ────────────────────────────────

// Mirrors the server's own pattern (server/src/schemas.ts) so a bad timezone
// is rejected here, in the same shape, instead of only surfacing as a 422
// after the request has already gone out.
const IANA_TZ = /^[A-Za-z]+(?:_[A-Za-z]+)*(?:\/[A-Za-z0-9+_-]+)+$/;

// Types that put material in front of the client (an upload, a decrypted
// secret) — an "owner" item is a private to-do for the account holder and
// never reaches the client portal, so none of these make sense on one.
const OWNER_FORBIDDEN_TYPES = new Set(['file', 'file_list', 'image', 'secret']);

export const itemKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'Item key must be snake_case: start with a lowercase letter, then letters/digits/underscores (e.g. "logo", "hero_copy", "ga4_id")',
  );

const itemTypeSchema = z.enum([
  'text',
  'longtext',
  'file',
  'file_list',
  'image',
  'color_list',
  'select',
  'multiselect',
  'boolean',
  'url',
  'secret',
  'structured',
]);

const constraintsSchema = z
  .object({
    formats: z.array(z.string().min(1).max(10)).max(20).optional(),
    min_width: z.number().int().positive().max(20000).optional(),
    min_height: z.number().int().positive().max(20000).optional(),
    max_width: z.number().int().positive().max(20000).optional(),
    max_height: z.number().int().positive().max(20000).optional(),
    // Bounds match the server (server/src/schemas.ts) — without them a value
    // that could never be satisfied (e.g. max_chars over 100k) only failed at
    // the API, after the intake had already been described to the caller.
    max_bytes: z.number().int().positive().max(500 * 1024 * 1024).optional(),
    min_chars: z.number().int().nonnegative().max(100000).optional(),
    max_chars: z.number().int().positive().max(100000).optional(),
    min_count: z.number().int().nonnegative().max(200).optional(),
    max_count: z.number().int().positive().max(200).optional(),
    transparent_background: z.boolean().optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.min_count !== undefined && c.max_count !== undefined && c.min_count > c.max_count) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['min_count'],
        message: 'min_count must not exceed max_count',
      });
    }
    if (c.min_chars !== undefined && c.max_chars !== undefined && c.min_chars > c.max_chars) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['min_chars'],
        message: 'min_chars must not exceed max_chars',
      });
    }
  })
  .optional();

// Every object below is strict, matching the API's own schemas. Zod strips
// unknown keys by default, so a mistyped parameter used to vanish between the
// agent and the request: `send_now: false` (the field is `send`) was dropped
// and the invite went out anyway, with nothing to tell the agent why. The API
// answers 422 for the same input, so failing here is the same contract, just
// reported before the request leaves.
const itemOptionSchema = z
  .object({
    value: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
  })
  .strict();

export const itemDefinitionSchema = z
  .object({
    key: itemKeySchema,
    type: itemTypeSchema,
    assignee: z.enum(['client', 'owner']).default('client'),
    label: z.string().min(1).max(200),
    help: z.string().max(1000).optional(),
    required: z.boolean().default(true),
    constraints: constraintsSchema,
    schema: z.record(z.unknown()).optional(),
    options: z.array(itemOptionSchema).max(100).optional(),
    pattern: z.string().max(300).optional(),
    // The answer you are proceeding on for a decision you cannot make yourself.
    proposed: z
      .object({
        value: z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).max(100)]),
        rationale: z.string().max(1000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.type === 'multiselect' && (!item.options || item.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'type=multiselect requires a non-empty options array',
      });
    }
    if (item.proposed && item.assignee !== 'owner') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposed'],
        message: 'proposed is only for assignee=owner decisions — a client item is answered by the client',
      });
    }
    if (item.proposed && item.type !== 'select' && item.type !== 'multiselect') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proposed'],
        message: `proposed needs type=select or type=multiselect, not ${item.type}`,
      });
    }
    if (item.type === 'select' && (!item.options || item.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'type=select requires a non-empty options array',
      });
    }
    if (item.type === 'structured' && !item.schema) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schema'],
        message: 'type=structured requires a JSON Schema object in `schema`',
      });
    }
    if (item.assignee === 'owner' && OWNER_FORBIDDEN_TYPES.has(item.type)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assignee'],
        message: `assignee=owner cannot use type=${item.type}; owner items are ticked off, not uploaded to`,
      });
    }
  });

const clientSchema = z
  .object({
    email: z.string().email().max(320),
    // Required, and validated here rather than left to the server's 422: every
    // email opens by addressing the client by name, so an agent that omits it
    // should be told which field to fill in, not handed an HTTP error.
    name: z
      .string()
      .trim()
      .min(1, "Client name is required — every email opens by addressing them.")
      .max(200),
    language: z.enum(['cs', 'sk', 'pl', 'de', 'es', 'en']).optional(),
    timezone: z.string().regex(IANA_TZ, 'Expected an IANA timezone like Europe/Prague').optional(),
    phone: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/, 'Phone must be E.164 format, e.g. +420601123456')
      .optional(),
    // Other people at the client who get the same link and the same reminders.
    also_notify: z
      .array(
        z
          .object({
            email: z.string().email().max(320),
            name: z.string().trim().min(1).max(200).optional(),
          })
          .strict(),
      )
      .max(4)
      .optional(),
  })
  .strict()
  .superRefine((client, ctx) => {
    // Catches a duplicate against the primary client too, not just among
    // also_notify entries — the server rejects it either way, and each extra
    // address multiplies what one send_chase puts on somebody's doorstep.
    const seen = new Set([client.email.trim().toLowerCase()]);
    for (const [i, extra] of (client.also_notify ?? []).entries()) {
      const key = extra.email.trim().toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['also_notify', i, 'email'],
          message: 'This address is already on the intake — one invitation each.',
        });
      }
      seen.add(key);
    }
  });

const brandingSchema = z
  .object({
    logo_url: z.string().url().optional(),
    accent_color: z
      .string()
      .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Expected a hex color like #1B2A4A')
      .optional(),
    sender_name: z.string().min(1).max(100).optional(),
      reply_to: z.string().email().optional(),
  })
  .strict();

const updateItemSchema = z
  .object({
    intake_id: z.string().min(1),
    item_key: itemKeySchema,
    type: itemTypeSchema.optional(),
    label: z.string().min(1).max(200).optional(),
    help: z.string().max(1000).nullable().optional(),
    required: z.boolean().optional(),
    constraints: constraintsSchema.unwrap().nullable().optional(),
    options: z.array(itemOptionSchema).max(100).nullable().optional(),
    pattern: z.string().max(300).nullable().optional(),
    discard_submitted_value: z.boolean().optional(),
  })
  .strict()
  .refine(
    v => Object.keys(v).some(k => !['intake_id', 'item_key', 'discard_submitted_value'].includes(k)),
    { message: 'Provide at least one field to change (type, label, help, required, constraints, options, pattern).' },
  );

const defineIntakeSchema = z
  .object({
    project_name: z.string().min(1).max(200),
    client: clientSchema,
    due_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
      .optional(),
    branding: brandingSchema.optional(),
    chase_schedule: z.enum(['default', 'gentle', 'aggressive', 'custom', 'off']).optional(),
    chase_interval: z.number().int().min(1).optional(),
    chase_interval_unit: z.enum(['minutes', 'hours', 'days']).optional(),
    respect_quiet_hours: z.boolean().optional(),
    max_reminders: z.union([z.number().int().min(1).max(1000), z.literal('unlimited')]).optional(),
    chase_at_time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a 24-hour local time like "07:00"')
      .optional(),
    email_copy: z
      .object({
        invite_subject: z.string().min(1).max(200).optional(),
        invite_intro: z.string().min(1).max(600).optional(),
        reminder_subject: z.string().min(1).max(200).optional(),
        reminder_intro: z.string().min(1).max(600).optional(),
      })
      .strict()
      .optional(),
    items: z.array(itemDefinitionSchema).min(1).max(100),
    template: z.string().max(100).optional(),
    auto_approve_hours: z.number().int().min(0).max(720).optional(),
    retention: z
      .object({
        mode: z.enum(['days', 'on_delivery']).optional(),
        days: z.number().int().min(1).max(3650).optional(),
        anonymize: z.boolean().optional(),
      })
      .strict()
      .optional(),
      send: z.boolean().optional(),
  })
  .strict();

// ─── MCP tool definitions (JSON schema, sent to the MCP client) ───────────────
//
// Every tool carries a title and annotations. A client uses readOnlyHint to
// decide what it may call without asking, and destructiveHint to decide what it
// must ask about first — so an annotation that flatters a tool is worse than
// none at all. get_intake_results is the one worth reading twice: it sounds like
// a read and is not one.

export const TOOLS = [
  {
    name: 'define_intake',
    title: 'Create client intake',
    // Creates an intake and emails the client. Idempotent: the package derives a stable key from the arguments, so a retried call returns the original intake rather than sending a second invitation.
    annotations: {
      title: 'Create client intake',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      // Every tool here reaches the BriefGate API over the network.
      openWorldHint: true,
    },
    description: `Create a new client intake request — a branded portal where the client submits logos, copy, files, credentials, and other assets. BriefGate sends the invite email and chases the client automatically until all items are collected.

Call this once at the start of a project, after you know what assets you need. Returns { intake_id, portal_url, status, follow_up }. Save intake_id — you need it for all follow-up calls.

AFTER CREATING AN INTAKE, SET UP HOW YOU WILL LEARN IT IS DONE. Nothing pushes to you on its own: MCP is request/response, so the server cannot wake you when the client finishes. Creating the intake and never checking again is the common failure — the completed work then sits in the portal until a human happens to look. The returned follow_up block tells you which of the two mechanisms applies:

- follow_up.recommended = "webhook" — the account already has an endpoint; deliveries will arrive there and you need do nothing further.
- follow_up.recommended = "schedule" — no endpoint is registered. If you control a service that can receive public HTTPS, register one with manage_webhook. Otherwise tell the user to set up a recurring check (cron, a systemd timer, a scheduled task in their agent host) that calls get_intake_status every follow_up.schedule.every_hours hours until follow_up.schedule.until, and offer to configure it for them.

Example:
{
  "project_name": "Website for John Finance",
  "client": { "email": "john@example.com", "name": "John", "language": "cs" },
  "due_date": "2026-08-15",
  "branding": { "accent_color": "#1B2A4A", "sender_name": "Radim" },
  "items": [
    { "key": "logo", "type": "image", "label": "Company logo",
      "constraints": { "formats": ["svg","png"], "min_width": 512 } },
    { "key": "hero_copy", "type": "longtext", "label": "Homepage headline (2–3 sentences)",
      "constraints": { "max_chars": 400 } },
    { "key": "wp_admin", "type": "secret", "label": "WordPress admin credentials" },
    { "key": "photos", "type": "file_list", "label": "Photos (5–10 images)",
      "constraints": { "formats": ["jpg","png","heic"], "min_count": 5, "max_count": 15 } }
  ]
}

Item types: text, longtext, file, file_list, image, color_list, select (one of options[]), multiselect (several of options[]; min_count/max_count in constraints), boolean, url, secret (encrypted; revealed exactly once — store the value on the first read), structured (requires schema with JSON Schema).

DECISIONS — questions for the developer, not the client. An item with assignee="owner" and type select/multiselect is a question only the account holder can settle ("does the discounted plan cost 19 or 29?"). Never stop and wait for one: give it a "proposed" answer and carry on building. proposed = { value: "19", rationale: "matches the competitor we benchmarked" } records what you went with and why; it is stored separately from the real answer, so it can never be mistaken for one the developer gave.

Read the answer back from get_intake_results. meta.<key>.decided_by tells you which it is: "owner" means a person settled it, "agent_proposal" means the build is still standing on your own pick and may yet be overruled. You cannot confirm your own proposal — answering is the developer's, through the dashboard.
Item keys must be snake_case (e.g. "logo", "hero_copy", "ga4_id") — they become property names in get_intake_results.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_name: {
          type: 'string',
          description: 'Human-readable project name shown in the invite email and portal heading.',
        },
        client: {
          type: 'object',
          description: 'Client contact details.',
          properties: {
            email: { type: 'string', description: 'Client email address (required).' },
            name: {
              type: 'string',
              description:
                'Client name (required). Every email opens by addressing them by name, ' +
                'so a blank one sends "Hello," to someone being asked for their admin password.',
            },
            language: {
              type: 'string',
              enum: ['cs', 'sk', 'pl', 'de', 'es', 'en'],
              description:
                'Portal and email language: cs, sk, pl, de, es, en. ' +
                "Omit it and the account's default language is used, falling back to English.",
            },
            timezone: {
              type: 'string',
              description: 'IANA timezone (e.g. Europe/Prague) for quiet-hours scheduling.',
            },
            phone: {
              type: 'string',
              description: 'E.164 phone number (e.g. +420601123456) — required for SMS reminders.',
            },
            also_notify: {
              type: 'array',
              description:
                'Other people who should receive the same invitation and the same reminders, through the ' +
                'same portal link — two directors of one company, say, where it does not matter which of ' +
                'them supplies the material. Each address gets its own message (nobody sees the others) ' +
                'and its own bounce state, so one dead address does not stop the rest being chased. ' +
                'At most 4, on top of the primary client.',
              items: {
                type: 'object',
                properties: {
                  email: { type: 'string', description: 'Their email address.' },
                  name: { type: 'string', description: 'Their name, used to address their copy.' },
                },
                required: ['email'],
              },
            },
          },
          required: ['email', 'name'],
        },
        due_date: {
          type: 'string',
          description: 'Deadline in YYYY-MM-DD format. Shown in the portal and used to escalate chase cadence.',
        },
        branding: {
          type: 'object',
          description: 'Override account-level branding for this intake.',
          properties: {
            logo_url: { type: 'string', description: 'https URL of your logo (shown in portal header).' },
            accent_color: { type: 'string', description: 'Hex accent color, e.g. #1B2A4A.' },
            sender_name: { type: 'string', description: 'Name shown as email sender, e.g. "Radim".' },
            reply_to: { type: 'string', description: 'Reply-to email address.' },
          },
        },
        chase_schedule: {
          type: 'string',
          enum: ['default', 'gentle', 'aggressive', 'custom', 'off'],
          description:
            'Automated reminder cadence. default=T+2d,T+5d,T+9d,weekly. gentle=T+3d,T+8d,biweekly. aggressive=T+1d,T+3d,T+5d,every-other-day. custom=every chase_interval chase_interval_unit. off=no auto reminders.',
        },
        chase_interval: {
          type: 'integer',
          minimum: 1,
          description:
            'How often to remind, only with chase_schedule="custom". Pair with chase_interval_unit. ' +
            'Defaults to every 3 days when omitted. The interval must work out to at least 5 minutes and at most 90 days.',
        },
        chase_interval_unit: {
          type: 'string',
          enum: ['minutes', 'hours', 'days'],
          description: 'Unit for chase_interval. Defaults to "days".',
        },
        respect_quiet_hours: {
          type: 'boolean',
          description:
            "Hold reminders to the client's 08:00-19:00 local window (default true). " +
            'A cadence of minutes or hours pauses overnight and resumes in the morning; set false to send around the clock.',
        },
        max_reminders: {
          description:
            'Reminders to send before the intake is marked stalled and handed back to you (default 3). ' +
            'An integer from 1 to 1000, or the string "unlimited" to keep reminding until the client finishes. ' +
            'Raise it for a rapid cadence, which would otherwise exhaust three attempts in minutes. ' +
            'A bounce or spam complaint always cancels the remaining reminders, whatever this is set to.',
          oneOf: [
            { type: 'integer', minimum: 1, maximum: 1000 },
            { type: 'string', enum: ['unlimited'] },
          ],
        },
        email_copy: {
          type: 'object',
          description:
            'Your own subject and intro lines, overriding the built-in translation for this intake. ' +
            'Placeholders: {sender}, {project}, {client}, {count}, {minutes}, {due}. ' +
            'An unknown placeholder is rejected rather than rendered literally to the client. ' +
            'Layout, button and footer stay as they are.',
          properties: {
            invite_subject: { type: 'string', maxLength: 200 },
            invite_intro: { type: 'string', maxLength: 600 },
            reminder_subject: { type: 'string', maxLength: 200 },
            reminder_intro: { type: 'string', maxLength: 600 },
          },
        },
        chase_at_time: {
          type: 'string',
          description:
            'Local time of day to send reminders at, "HH:MM" in the client\'s timezone (e.g. "07:00"). ' +
            'Anchors the cadence to a clock time instead of counting from the invite, and needs an interval ' +
            'measured in whole days. Naming a time deliberately overrides quiet hours, so "07:00" stays 07:00.',
        },
        items: {
          type: 'array',
          description: 'List of assets to collect. Each item has key, type, label, and optional constraints.',
          items: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description:
                  'snake_case identifier (e.g. "logo", "hero_copy"). Becomes the property name in get_intake_results output.',
              },
              type: {
                type: 'string',
                enum: [
                  'text',
                  'longtext',
                  'file',
                  'file_list',
                  'image',
                  'color_list',
                  'select',
                  'multiselect',
                  'boolean',
                  'url',
                  'secret',
                  'structured',
                ],
              },
              assignee: {
                type: 'string',
                enum: ['client', 'owner'],
                description:
                  'Who owes this. "client" (the default) is something the client fills in through the portal. ' +
                  '"owner" is a private to-do for the account holder, e.g. "call the client": it never appears ' +
                  'in the client portal, is never mentioned in a reminder, and never holds up completion of the ' +
                  'intake. Use type "boolean" for a plain tick-off task. Owner items cannot use type file, ' +
                  'file_list, image or secret.',
              },
              label: { type: 'string', description: 'Human-readable label shown to the client.' },
              help: { type: 'string', description: 'Additional instructions shown below the label.' },
              required: { type: 'boolean', description: 'Whether the client must fill this in. Default: true.' },
              constraints: {
                type: 'object',
                description:
                  'Type-specific constraints: formats, min_width/min_height (image), min_chars/max_chars (text), min_count/max_count (file_list).',
              },
              schema: {
                type: 'object',
                description: 'JSON Schema for type=structured. Required when type=structured.',
              },
              options: {
                type: 'array',
                description:
                  'Dropdown options for type=select. Required when type=select. Each item: { value, label }.',
                items: {
                  type: 'object',
                  properties: {
                    value: { type: 'string' },
                    label: { type: 'string' },
                  },
                  required: ['value', 'label'],
                },
              },
              pattern: { type: 'string', description: 'Regex pattern for type=text validation (e.g. "^G-[A-Z0-9]+$").' },
            },
            required: ['key', 'type', 'label'],
          },
          minItems: 1,
          maxItems: 100,
        },
        template: {
          type: 'string',
          description: 'Template slug to pre-populate items (e.g. "restaurant-website", "consulting-firm").',
        },
        auto_approve_hours: {
          type: 'number',
          description:
            'Hours after submission before an item is auto-approved without agent review. Default: 72. Set to 0 to require explicit approval.',
        },
        retention: {
          type: 'object',
          description:
            'How long BriefGate keeps this intake after it is finished. Default: purged 90 days after the client completes. ' +
            'Use mode "on_delivery" when the intake holds anything sensitive (credentials, personal photos): the contents are ' +
            'then removed shortly after YOU collect them with get_intake_results, because at that point you already have the ' +
            'files and there is no reason for a copy to sit on our server. An intake you never collect still expires on the ' +
            'day count, so this can only ever delete data earlier, never later. ' +
            'Example: { "mode": "on_delivery" } — or { "mode": "days", "days": 7 } to just shorten the window.',
          properties: {
            mode: {
              type: 'string',
              enum: ['days', 'on_delivery'],
              description:
                '"days" (default): purge N days after the client finishes. "on_delivery": purge ~24h after you collect the results.',
            },
            days: {
              type: 'number',
              description: 'Days to keep after completion. Only valid with mode "days". Defaults to the account setting (90).',
            },
            anonymize: {
              type: 'boolean',
              description:
                'Default true: keep the project record (name, item labels, statuses, dates) and delete everything belonging to ' +
                'the client — files, secrets, submitted values, email, name, phone, and the portal link. Set false to delete the ' +
                'whole intake including its history.',
            },
          },
        },
        send: {
          type: 'boolean',
          description:
            'Whether to send the invite email immediately. Default: true. Set to false to create a draft and call /v1/intakes/:id/send later.',
        },
      },
      required: ['project_name', 'client', 'items'],
    },
  },

  {
    name: 'get_intake_status',
    title: 'Check intake progress',
    // Reads only.
    annotations: {
      title: 'Check intake progress',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      // Every tool here reaches the BriefGate API over the network.
      openWorldHint: true,
    },
    description: `Check the completion status of a client intake — which items are submitted, pending, or need revision; the history of automated chase emails sent; and when the client last opened the portal.

Use this to decide whether to send a manual reminder (send_chase), request a revision (request_revision), or fetch results (get_intake_results). Returns per-item status and chase history.

This is also the call a scheduled check should make when no webhook is registered — see follow_up in the define_intake response for the cadence. When status becomes "completed", fetch the results with get_intake_results and carry on with the work that was waiting on them.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        intake_id: {
          type: 'string',
          description: 'Intake ID returned by define_intake (e.g. "in_8f3k").',
        },
      },
      required: ['intake_id'],
    },
  },

  {
    name: 'get_intake_results',
    title: 'Collect intake results',
    // Not read-only, despite the name. A secret item is released exactly ONCE — this call burns it, and a later call returns the time of the reveal instead of the value. On an intake with retention.mode "on_delivery" it also starts the clock that deletes the contents about 24 hours later. Both are irreversible, so this is a destructive read.
    annotations: {
      title: 'Collect intake results',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      // Every tool here reaches the BriefGate API over the network.
      openWorldHint: true,
    },
    description: `Retrieve the typed submitted values from a client intake.

Files are returned as signed URLs valid for 24 hours — download them promptly or store the URL for reuse within that window.

Secrets (type=secret, e.g. passwords, API keys) are decrypted and returned in plaintext on the FIRST call only. After the first retrieval the secret is marked as read: subsequent calls return first_reveal: false in meta and omit the value. Store secrets immediately before proceeding — you cannot retrieve them again.

Use only_new=true to get only items submitted since the last call (useful in webhook-driven workflows). Use include_pending=true to also return partially filled items.

Returns { results: { <key>: <typed value> }, meta: { <key>: { type, status, submitted_at, first_reveal? } } }.

For a DECISION (assignee=owner, type select/multiselect) results holds the answer currently standing and meta.<key>.decided_by says whose it is: "owner" once a person has settled it, "agent_proposal" while it is still your own pick. A proposed decision is returned even without include_pending — you need back the assumption you are building on. It does not bump revision, so an only_new read surfaces exactly the decisions a person has since answered or changed.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        intake_id: {
          type: 'string',
          description: 'Intake ID returned by define_intake.',
        },
        only_new: {
          type: 'boolean',
          description:
            'Return only items submitted or updated since the previous get_intake_results call. Default: false.',
        },
        include_pending: {
          type: 'boolean',
          description: 'Include items not yet submitted (useful for partial progress checks). Default: false.',
        },
      },
      required: ['intake_id'],
    },
  },

  {
    name: 'request_revision',
    title: 'Request a revision',
    // Sends the client back to an item they had already submitted, and emails them about it.
    annotations: {
      title: 'Request a revision',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      // Every tool here reaches the BriefGate API over the network.
      openWorldHint: true,
    },
    description: `Ask the client to resubmit a specific item with a note explaining what is wrong.

Use this after reviewing get_intake_results and finding an item that does not meet requirements — for example a blurry logo, copy that is too long, or a broken URL. The client is notified automatically and the item status moves to needs_revision.

Returns { status: "revision_requested", item_key }.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        intake_id: {
          type: 'string',
          description: 'Intake ID returned by define_intake.',
        },
        item_key: {
          type: 'string',
          description: 'The key of the item to revise (e.g. "logo", "hero_copy").',
        },
        note: {
          type: 'string',
          description:
            'Plain-language explanation shown to the client (e.g. "Logo is blurry — we need at least 512 px wide in SVG or PNG with a transparent background").',
        },
      },
      required: ['intake_id', 'item_key', 'note'],
    },
  },

  {
    name: 'send_chase',
    title: 'Send a reminder',
    // Sends an email or SMS to the client. Nothing can unsend it, but it destroys no state.
    annotations: {
      title: 'Send a reminder',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      // Every tool here reaches the BriefGate API over the network.
      openWorldHint: true,
    },
    description: `Send a manual reminder to the client outside the automatic schedule.

Use when a deadline is approaching and the client has not responded to automatic reminders, or when you want to send an SMS after email attempts have failed. The automatic chase schedule continues after this call — this is an extra nudge, not a replacement.

Returns { sent: true }.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        intake_id: {
          type: 'string',
          description: 'Intake ID returned by define_intake.',
        },
        channel: {
          type: 'string',
          enum: ['email'],
          description: 'Delivery channel. Email is the only one offered.',
        },
      },
      required: ['intake_id'],
    },
  },

  {
    name: 'list_intakes',
    title: 'List intakes',
    // Reads only.
    annotations: {
      title: 'List intakes',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      // Every tool here reaches the BriefGate API over the network.
      openWorldHint: true,
    },
    description: `List all intakes in your account, optionally filtered by status or client email.

Use this to get an overview of active projects, find a specific intake by the client's email when you have lost the intake_id, or check how many intakes are currently in progress.

Returns { intakes: [...], total } where each intake includes intake_id, project_name, status, created_at, due_date, and portal_url.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: ['draft', 'sent', 'in_progress', 'completed', 'archived'],
          description: 'Filter by intake status. Omit to return all.',
        },
        client_email: {
          type: 'string',
          description: 'Filter by client email address.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (1–100). Default: 20.',
        },
        offset: {
          type: 'number',
          description: 'Pagination offset. Default: 0.',
        },
      },
      required: [],
    },
  },

  {
    name: 'add_items',
    title: 'Add items to an intake',
    // Adds to an existing intake and notifies the client. Purely additive.
    annotations: {
      title: 'Add items to an intake',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      // Every tool here reaches the BriefGate API over the network.
      openWorldHint: true,
    },
    description: `Add new items to an already-sent intake — for example, when you realise mid-project that you also need a favicon, social media assets, or additional credentials.

The client is notified about the new items. Existing items and their submitted values are not affected. Returns the updated intake object.

Items must follow the same key/type/label rules as define_intake (snake_case keys, type-specific constraints).`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        intake_id: {
          type: 'string',
          description: 'Intake ID returned by define_intake.',
        },
        items: {
          type: 'array',
          description: 'New items to add. Same schema as define_intake items.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'snake_case key, unique within the intake.' },
              type: {
                type: 'string',
                enum: [
                  'text', 'longtext', 'file', 'file_list', 'image',
                  'color_list', 'select', 'multiselect', 'boolean', 'url', 'secret', 'structured',
                ],
              },
              label: { type: 'string', description: 'Human-readable label shown to the client.' },
              help: { type: 'string' },
              required: { type: 'boolean' },
              constraints: { type: 'object' },
              schema: { type: 'object' },
              options: { type: 'array', items: { type: 'object' } },
              pattern: { type: 'string' },
            },
            required: ['key', 'type', 'label'],
          },
          minItems: 1,
          maxItems: 50,
        },
      },
      required: ['intake_id', 'items'],
    },
  },

  {
    name: 'update_item',
    title: 'Edit an item',
    // Destructive because discard_submitted_value throws away an answer the client has already given.
    annotations: {
      title: 'Edit an item',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      // Every tool here reaches the BriefGate API over the network.
      openWorldHint: true,
    },
    description: `Change one item on an intake that is already with the client — its type, label, hint, whether it is required, and which file formats it accepts.

Reach for this when the field turns out to be the wrong shape: you asked for an image and the client only has their logo as a PDF, or what you asked for as a line of text is really a file. Widening the accepted formats or switching the type unblocks them without adding a duplicate item and waiving the original.

The item key cannot be changed — results come back under it, so renaming would break whatever reads them. Add a new item instead.

If the client has already answered and the change would make their answer invalid, the call fails and nothing is touched. Repeat it with discard_submitted_value: true to clear the answer and ask them again. A change that leaves their answer valid (a new label, a wider limit) never discards anything.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        intake_id: { type: 'string', description: 'Intake ID returned by define_intake.' },
        item_key: { type: 'string', description: 'Key of the item to change.' },
        type: {
          type: 'string',
          enum: [
            'text', 'longtext', 'file', 'file_list', 'image',
            'color_list', 'select', 'multiselect', 'boolean', 'url', 'secret', 'structured',
          ],
        },
        label: { type: 'string', description: 'Human-readable label shown to the client.' },
        help: { type: ['string', 'null'], description: 'Hint under the label. null clears it.' },
        required: { type: 'boolean' },
        constraints: {
          type: ['object', 'null'],
          description: 'Same shape as define_intake, e.g. { "formats": ["svg","png","pdf"] }. null clears all constraints.',
        },
        options: { type: ['array', 'null'], items: { type: 'object' } },
        pattern: { type: ['string', 'null'] },
        discard_submitted_value: {
          type: 'boolean',
          description: 'Go ahead even though it throws away what the client already sent. Only set this after the call has failed once for that reason.',
        },
      },
      required: ['intake_id', 'item_key'],
    },
  },

  {
    name: 'manage_webhook',
    title: 'Manage webhook endpoints',
    // Destructive because action "delete" removes an endpoint, and its signing secret cannot be recovered.
    annotations: {
      title: 'Manage webhook endpoints',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      // Every tool here reaches the BriefGate API over the network.
      openWorldHint: true,
    },
    description: `Register, list, or remove a webhook endpoint so BriefGate pushes intake events to your service instead of you polling for them.

Use this ONLY if you control a service that can receive public HTTPS requests. An agent running in a terminal cannot — for that case do not register anything and check on a schedule with get_intake_status instead. A registered endpoint that cannot receive produces failing deliveries and a false impression that the work is being watched.

action="create" returns a "secret" exactly once. Store it somewhere durable outside this conversation: it is needed to verify the signature on every delivery (use verifyWebhookSignature from @briefgate/mcp/webhook) and it cannot be retrieved again. If it is ever exposed, there is no rotation in place — delete the endpoint and create a new one, which issues a fresh secret.

Events: intake.completed (all required items in — the one to act on), item.submitted (a single item arrived), client.viewed (the client opened the portal), chase.bounced (a reminder failed to deliver), intake.overdue (the due date passed with required items outstanding — the one to act on when work is blocked), intake.stalled (fires only when the intake sets max_reminders; without it this event never arrives).`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'delete'],
          description: 'What to do. "list" needs no other argument.',
        },
        url: {
          type: 'string',
          description: 'HTTPS endpoint to deliver to. Required for action="create".',
        },
        events: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'item.submitted',
              'intake.completed',
              'client.viewed',
              'chase.bounced',
              'intake.stalled',
              'intake.overdue',
            ],
          },
          description:
            'Events to receive. Required for action="create". For "tell me when the client is done", this is ["intake.completed"].',
        },
        format: {
          type: 'string',
          enum: ['raw', 'slack', 'discord'],
          description:
            'Payload shape. "raw" (default) is the signed BriefGate envelope; "slack" and "discord" post a message those services render directly.',
        },
        webhook_id: {
          type: 'string',
          description: 'Endpoint to remove. Required for action="delete".',
        },
      },
      required: ['action'],
    },
  },
];

// ─── Tool result type ─────────────────────────────────────────────────────────

export interface ToolResult {
  text: string;
  isError?: boolean;
}

// ─── Idempotency key ──────────────────────────────────────────────────────────

// Derive a stable key from project name + client email + a canonical hash of
// the items list. Including items prevents two *different* intakes for the same
// client/project (e.g. a new project a year later with a different scope) from
// colliding on the server: same project_name + client but different items →
// different key → two distinct intakes. Retries with identical args still
// produce the same key, so the server correctly deduplicates them.
function deriveIdempotencyKey(
  projectName: string,
  clientEmail: string,
  items: Array<{ key: string; [k: string]: unknown }>,
): string {
  // Sort by key so insertion order doesn't affect the hash.
  const sortedItems = [...items].sort((a, b) => (a.key > b.key ? 1 : -1));
  const itemsFingerprint = createHash('sha256')
    .update(JSON.stringify(sortedItems))
    .digest('hex')
    .slice(0, 16);

  return createHash('sha256')
    .update(`${projectName}\0${clientEmail}\0${itemsFingerprint}`)
    .digest('hex')
    .slice(0, 40);
}

function validationError(issues: z.ZodIssue[]): ToolResult {
  const messages = issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  return { text: `Validation error: ${messages}`, isError: true };
}

// ─── Execute functions ────────────────────────────────────────────────────────

const UNIT_MINUTES = { minutes: 1, hours: 60, days: 24 * 60 } as const;

/**
 * Things a caller asking for a fast cadence almost certainly wants to know, and
 * would otherwise only discover when the reminders stopped after three tries.
 *
 * These are returned to the calling agent rather than resolved here: whether to
 * nag a client hourly through the night is the developer's call, not ours, and
 * the agent is the one that can ask them.
 */
function cadenceNotices(input: z.infer<typeof defineIntakeSchema>): string[] {
  const out: string[] = [];
  if (input.chase_schedule !== 'custom') return out;

  const minutes =
    input.chase_interval === undefined
      ? undefined
      : input.chase_interval * UNIT_MINUTES[input.chase_interval_unit ?? 'days'];

  const subDaily = minutes !== undefined && minutes < UNIT_MINUTES.days;

  if (subDaily && input.max_reminders === undefined) {
    out.push(
      'Reminders stop after 3 attempts by default, so this cadence will be exhausted quickly and the intake ' +
        'will be marked stalled. Ask whether to raise the cap — pass max_reminders (1-1000), or "unlimited" ' +
        'to keep reminding until the client finishes. A bounce or spam complaint cancels the rest either way.',
    );
  }

  if (subDaily && input.respect_quiet_hours === undefined && input.chase_at_time === undefined) {
    out.push(
      "Quiet hours are on by default, so reminders only go out between 08:00 and 19:00 in the client's " +
        'timezone and this cadence pauses overnight. Ask whether reminders should also arrive outside those ' +
        'hours — pass respect_quiet_hours: false to send around the clock.',
    );
  }

  if (input.chase_at_time !== undefined) {
    out.push(
      `Reminders are anchored to ${input.chase_at_time} in the client's timezone. A time named explicitly ` +
        'overrides quiet hours, so it is used even if it falls outside 08:00-19:00.',
    );
  }

  return out;
}

export async function callDefineIntake(
  config: BriefGateConfig,
  args: unknown,
): Promise<ToolResult> {
  const parsed = defineIntakeSchema.safeParse(args);
  if (!parsed.success) return validationError(parsed.error.issues);

  const { project_name, client, items, ...rest } = parsed.data;
  const idempotencyKey = deriveIdempotencyKey(project_name, client.email, items);

  const result = await createIntake(
    config,
    { project_name, client, items, ...rest },
    idempotencyKey,
  );

  const notices = cadenceNotices(parsed.data);

  return {
    text: JSON.stringify(
      {
        intake_id: result.intake_id,
        portal_url: result.portal_url,
        status: result.status,
        // Passed through rather than dropped: the tool description tells the
        // caller to act on this, and picking fields by hand here is what made
        // it invisible in 0.5.0 — the advice existed on the wire and never
        // reached the agent it was written for.
        ...(result.follow_up ? { follow_up: result.follow_up } : {}),
        ...(notices.length > 0 ? { notices } : {}),
      },
      null,
      2,
    ),
  };
}

export async function callGetIntakeStatus(
  config: BriefGateConfig,
  args: unknown,
): Promise<ToolResult> {
  const parsed = z.object({ intake_id: z.string().min(1) }).safeParse(args);
  if (!parsed.success) return validationError(parsed.error.issues);

  const result = await getIntakeStatus(config, parsed.data.intake_id);
  return { text: JSON.stringify(result, null, 2) };
}

export async function callGetIntakeResults(
  config: BriefGateConfig,
  args: unknown,
): Promise<ToolResult> {
  const parsed = z
    .object({
      intake_id: z.string().min(1),
      only_new: z.boolean().optional(),
      include_pending: z.boolean().optional(),
    })
    .safeParse(args);
  if (!parsed.success) return validationError(parsed.error.issues);

  const { intake_id, only_new, include_pending } = parsed.data;
  const result = await getIntakeResults(config, intake_id, {
    only_new: only_new ?? false,
    include_pending: include_pending ?? false,
  });
  return { text: JSON.stringify(result, null, 2) };
}

export async function callRequestRevision(
  config: BriefGateConfig,
  args: unknown,
): Promise<ToolResult> {
  const parsed = z
    .object({
      intake_id: z.string().min(1),
      item_key: z.string().min(1),
      note: z.string().min(1).max(2000),
    })
    .safeParse(args);
  if (!parsed.success) return validationError(parsed.error.issues);

  const result = await requestRevision(
    config,
    parsed.data.intake_id,
    parsed.data.item_key,
    parsed.data.note,
  );
  return { text: JSON.stringify(result, null, 2) };
}

export async function callSendChase(
  config: BriefGateConfig,
  args: unknown,
): Promise<ToolResult> {
  const parsed = z
    .object({
      intake_id: z.string().min(1),
      // The API still accepts "sms"; this client does not offer it. There is no
      // way for a customer to buy the credits an SMS spends, so an agent that
      // asked for one would get a 402 it could do nothing about.
      channel: z.enum(['email']).optional(),
    })
    .safeParse(args);
  if (!parsed.success) return validationError(parsed.error.issues);

  const result = await sendChase(config, parsed.data.intake_id, parsed.data.channel);
  return { text: JSON.stringify(result, null, 2) };
}

export async function callListIntakes(
  config: BriefGateConfig,
  args: unknown,
): Promise<ToolResult> {
  const parsed = z
    .object({
      status: z
        .enum(['draft', 'sent', 'in_progress', 'completed', 'archived'])
        .optional(),
      client_email: z.string().email().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .safeParse(args);
  if (!parsed.success) return validationError(parsed.error.issues);

  const result = await listIntakes(config, parsed.data);
  return { text: JSON.stringify(result, null, 2) };
}

export async function callAddItems(
  config: BriefGateConfig,
  args: unknown,
): Promise<ToolResult> {
  const parsed = z
    .object({
      intake_id: z.string().min(1),
      items: z.array(itemDefinitionSchema).min(1).max(50),
    })
    .safeParse(args);
  if (!parsed.success) return validationError(parsed.error.issues);

  const result = await addItems(config, parsed.data.intake_id, parsed.data.items);
  return { text: JSON.stringify(result, null, 2) };
}

export async function callUpdateItem(
  config: BriefGateConfig,
  args: unknown,
): Promise<ToolResult> {
  const parsed = updateItemSchema.safeParse(args);
  if (!parsed.success) return validationError(parsed.error.issues);

  const { intake_id, item_key, ...changes } = parsed.data;
  const result = await updateItem(config, intake_id, item_key, changes);
  return { text: JSON.stringify(result, null, 2) };
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export async function callManageWebhook(
  config: BriefGateConfig,
  args: unknown,
): Promise<ToolResult> {
  const parsed = z
    .object({
      action: z.enum(['create', 'list', 'delete']),
      url: z.string().min(1).optional(),
      events: z
        .array(
          z.enum([
            'item.submitted',
            'intake.completed',
            'client.viewed',
            'chase.bounced',
            'intake.stalled',
            'intake.overdue',
          ]),
        )
        .min(1)
        .optional(),
      format: z.enum(['raw', 'slack', 'discord']).optional(),
      webhook_id: z.string().min(1).optional(),
    })
    .strict()
    .safeParse(args);
  if (!parsed.success) return validationError(parsed.error.issues);
  const { action, url, events, format, webhook_id: webhookId } = parsed.data;

  // Checked here rather than in the schema so the message names the action the
  // caller actually asked for; a discriminated union would report the failure
  // against every branch at once.
  if (action === 'create') {
    if (!url || !events) {
      return { text: 'manage_webhook action="create" needs both `url` and `events`.', isError: true };
    }
    const created = await createWebhook(config, { url, events, ...(format ? { format } : {}) });
    return {
      text: JSON.stringify(
        {
          ...created,
          note: 'Store `secret` now — it verifies every delivery signature and is returned only on creation.',
        },
        null,
        2,
      ),
    };
  }

  if (action === 'delete') {
    if (!webhookId) {
      return { text: 'manage_webhook action="delete" needs `webhook_id`.', isError: true };
    }
    return { text: JSON.stringify(await deleteWebhook(config, webhookId), null, 2) };
  }

  return { text: JSON.stringify(await listWebhooks(config), null, 2) };
}

export async function executeTool(
  name: string,
  config: BriefGateConfig,
  args: unknown,
): Promise<ToolResult> {
  switch (name) {
    case 'define_intake':
      return callDefineIntake(config, args);
    case 'get_intake_status':
      return callGetIntakeStatus(config, args);
    case 'get_intake_results':
      return callGetIntakeResults(config, args);
    case 'request_revision':
      return callRequestRevision(config, args);
    case 'send_chase':
      return callSendChase(config, args);
    case 'list_intakes':
      return callListIntakes(config, args);
    case 'add_items':
      return callAddItems(config, args);
    case 'update_item':
      return callUpdateItem(config, args);
    case 'manage_webhook':
      return callManageWebhook(config, args);
    default:
      return { text: `Unknown tool: ${name}`, isError: true };
  }
}
