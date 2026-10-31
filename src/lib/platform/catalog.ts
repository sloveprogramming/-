/**
 * Platform integrations: the services AgentSDR itself runs on — Unipile for
 * LinkedIn and WhatsApp, Google Workspace for Gmail, Cloudflare R2 for call
 * recordings. Each is connected once per organization from the Connection
 * page of the channel it powers (PLATFORM_SETTINGS_HREF), and a feature works
 * only while its integration is connected. None of them is read from env.
 *
 * Not to be confused with `src/lib/integrations`, the enrichment providers a
 * grid column calls per row (any number of accounts each). OpenRouter is not
 * here either: it has its own connection flow under `src/lib/ai`
 * (Settings → AI provider).
 *
 * Client-safe — the settings UI imports this. Credentials are resolved in
 * `credentials.ts`.
 */

import { docsPageUrl } from "@/lib/support";

export type PlatformKey = "unipile" | "google" | "r2" | "gologin" | "wecom";

/** The decrypted credential object stored for each platform. */
export type PlatformCredentials = {
  unipile: {
    /** The DSN from the Unipile dashboard, e.g. https://api8.unipile.com:13851 — no trailing slash. */
    baseUrl: string;
    apiKey: string;
    /**
     * Sent by Unipile as the `x-unipile-secret` header (or `?secret=`) on
     * every webhook. Generated on first save when left empty.
     */
    notifySecret: string;
  };
  google: {
    /** The service account's email, …@….iam.gserviceaccount.com. */
    clientEmail: string;
    /** PEM, -----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----. */
    privateKey: string;
    /** Pub/Sub topic Gmail publishes new-mail notifications to. Empty means replies are not picked up. */
    gmailWatchTopic: string;
  };
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
  };
  gologin: {
    /** A GoLogin API token (Settings → API). */
    apiToken: string;
  };
  /**
   * 企业微信自建应用。改造新增：国内 B2B 的主渠道，替代原来的 LinkedIn。
   *
   * 用自建应用而不是第三方服务商：新农哥是单一企业，自建应用（corpId + agentId
   * + secret）权限够用、不依赖服务商、也没有套餐费。
   */
  wecom: {
    /** 企业 ID，在企微管理后台「我的企业」页面底部。 */
    corpId: string;
    /** 自建应用的 AgentId 与 Secret，在「应用管理 → 自建 → 应用详情」。 */
    agentId: string;
    secret: string;
    /**
     * 接收消息回调用的 Token 与 EncodingAESKey。
     * 在应用详情页「接收消息」处设置；留空则只发不收。
     */
    callbackToken: string;
    callbackAesKey: string;
  };
};

export type PlatformField = {
  key: string;
  label: string;
  placeholder?: string;
  /** Where to find the value — written for someone who has never opened the provider's console. */
  help?: string;
  inputType: "text" | "password" | "textarea";
  required: boolean;
  /**
   * Secret values are never sent back to the browser; leaving one blank when
   * editing keeps the saved value. Non-secret values are shown and prefilled.
   */
  secret: boolean;
};

/** A step, optionally with a value the user must paste elsewhere verbatim — shown with a Copy button. */
export type SetupStep = string | { text: string; copy: string };

export type PlatformIntegration = {
  key: PlatformKey;
  name: string;
  description: string;
  /** What stops working without it — shown on the card and in Connect prompts. */
  enables: string[];
  websiteUrl: string;
  /** The provider's own mark, under public/Integrations - Icon/. */
  iconUrl: string;
  /** Numbered "How to connect" steps at the top of the connect dialog. */
  setupSteps: SetupStep[];
  /** Our own written walkthrough (docs.agentsdr.ai), shown as "How to connect" wherever it is connected. */
  guideUrl?: string;
  /** Our own video walkthrough, once there is one. */
  videoUrl?: string;
  /** The provider's reference docs. */
  docsUrl?: string;
  fields: PlatformField[];
  /**
   * A credentials file the provider hands out, read in the browser to fill
   * the fields so nobody has to open it. Returns field values; throws an
   * Error with a user-facing message if the file is not the expected kind.
   */
  keyFile?: {
    label: string;
    accept: string;
    read: (text: string) => Record<string, string>;
  };
};

const GMAIL_SCOPES = "https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly";

export const PLATFORM_INTEGRATIONS: readonly PlatformIntegration[] = [
  {
    key: "unipile",
    name: "Unipile",
    description: "Connects LinkedIn and WhatsApp accounts for sending, inbox sync and calling.",
    enables: ["LinkedIn accounts and campaigns", "WhatsApp messaging and calling"],
    websiteUrl: "https://www.unipile.com",
    iconUrl: "/Integrations - Icon/unipile.png",
    guideUrl: docsPageUrl("integrations/unipile"),
    docsUrl: "https://developer.unipile.com/docs/getting-started",
    setupSteps: [
      "Sign in to the Unipile dashboard at dashboard.unipile.com.",
      "Copy your DSN — the API address shown at the top of the dashboard.",
      "Under Access tokens, generate a token and copy it. It is shown only once.",
      "Save. AgentSDR registers the webhooks it needs in your Unipile workspace itself, with a secret it generates.",
    ],
    fields: [
      {
        key: "baseUrl",
        label: "DSN (API address)",
        placeholder: "api8.unipile.com:13851",
        help: "Shown at the top of the Unipile dashboard. Paste it as it appears — https:// is added if missing.",
        inputType: "text",
        required: true,
        secret: false,
      },
      {
        key: "apiKey",
        label: "Access token",
        help: "Unipile dashboard → Access tokens → Generate. Copy it right away; Unipile shows it only once.",
        inputType: "password",
        required: true,
        secret: true,
      },
      {
        key: "notifySecret",
        label: "Webhook secret",
        help: "Leave empty: AgentSDR generates one and registers the webhooks with it. Fill it in only to keep a secret you already use.",
        inputType: "password",
        required: false,
        secret: true,
      },
    ],
  },
  {
    key: "google",
    name: "Google Workspace",
    description: "通过带全域委派的服务账号收发 Gmail。",
    enables: ["发信邮箱", "邮件营销活动与回复同步"],
    websiteUrl: "https://workspace.google.com",
    iconUrl: "/Integrations - Icon/google.svg",
    guideUrl: docsPageUrl("integrations/google-workspace"),
    docsUrl: "https://developers.google.com/identity/protocols/oauth2/service-account#delegatingauthority",
    setupSteps: [
      "In the Google Cloud console, open APIs & Services → Library and enable the Gmail API.",
      "Open IAM & Admin → Service accounts → Create service account. It needs no roles.",
      "Open the new service account → Keys → Add key → Create new key → JSON. A key file downloads.",
      {
        text: "In the Google Admin console, open Security → Access and data control → API controls → Manage domain-wide delegation → Add new. Paste the service account's Client ID (on its Details tab) and these scopes:",
        copy: GMAIL_SCOPES,
      },
      "Upload the key file below to fill in the fields, or copy each value in by hand.",
    ],
    fields: [
      {
        key: "clientEmail",
        label: "服务账号邮箱",
        placeholder: "agentsdr@my-project.iam.gserviceaccount.com",
        help: "Google Cloud console → IAM & Admin → Service accounts, in the Email column. It ends in .iam.gserviceaccount.com.",
        inputType: "text",
        required: true,
        secret: false,
      },
      {
        key: "privateKey",
        label: "私钥",
        placeholder: "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----",
        help: "Google only gives this out inside a JSON key file (service account → Keys → Add key → Create new key → JSON). Upload that file above, or open it and copy the private_key value, from -----BEGIN to END PRIVATE KEY-----.",
        inputType: "textarea",
        required: true,
        secret: true,
      },
      {
        key: "gmailWatchTopic",
        label: "Gmail Pub/Sub 主题",
        placeholder: "projects/my-project/topics/agentsdr-inbox",
        help: "Google Cloud console → Pub/Sub → Topics: create a topic, give gmail-api-push@system.gserviceaccount.com the Pub/Sub Publisher role on it, and copy its full name. Sending works without it, but email replies are not picked up.",
        inputType: "text",
        required: false,
        secret: false,
      },
    ],
    keyFile: {
      label: "上传密钥文件",
      accept: "application/json,.json",
      read: (text) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error("That file is not a Google key file (it is not JSON).");
        }
        const key = (parsed ?? {}) as Record<string, unknown>;
        if (key.type !== "service_account" || typeof key.client_email !== "string" || typeof key.private_key !== "string") {
          throw new Error("That file is not a service account key file. Download one from the service account's Keys tab.");
        }
        return { clientEmail: key.client_email, privateKey: key.private_key };
      },
    },
  },
  {
    key: "r2",
    name: "Cloudflare R2",
    description: "Stores WhatsApp call recordings and contact photos.",
    enables: ["Call recordings", "Contact photos"],
    websiteUrl: "https://www.cloudflare.com/developer-platform/products/r2/",
    iconUrl: "/Integrations - Icon/cloudflare.svg",
    guideUrl: docsPageUrl("integrations/cloudflare-r2"),
    docsUrl: "https://developers.cloudflare.com/r2/api/tokens/",
    setupSteps: [
      "In the Cloudflare dashboard, open R2 Object Storage and create a bucket for recordings (or pick an existing one).",
      "Copy your Account ID from the R2 overview page.",
      "Open Manage API tokens → Create API token, give it Object Read & Write on that bucket, and copy the Access Key ID and Secret Access Key. The secret is shown only once.",
    ],
    fields: [
      {
        key: "accountId",
        label: "Account ID",
        help: "Cloudflare dashboard → R2 Object Storage, under Account details on the overview page.",
        inputType: "text",
        required: true,
        secret: false,
      },
      {
        key: "bucket",
        label: "Bucket name",
        help: "The bucket's name exactly as listed under R2 Object Storage.",
        inputType: "text",
        required: true,
        secret: false,
      },
      {
        key: "accessKeyId",
        label: "Access key ID",
        help: "Shown when you create an R2 API token (R2 Object Storage → Manage API tokens).",
        inputType: "text",
        required: true,
        secret: false,
      },
      {
        key: "secretAccessKey",
        label: "Secret access key",
        help: "Shown once, next to the access key ID, when you create the token.",
        inputType: "password",
        required: true,
        secret: true,
      },
    ],
  },
  {
    key: "gologin",
    name: "GoLogin",
    description: "Browser profiles that run cloud calling numbers' WhatsApp Web, so AI agent calls can be placed without anyone's laptop.",
    enables: ["Cloud calling numbers (GoLogin launchers)"],
    websiteUrl: "https://gologin.com",
    // No bundled mark in public/: the favicon, as the grid's integration icons fall back to.
    iconUrl: "https://www.google.com/s2/favicons?domain=gologin.com&sz=64",
    guideUrl: docsPageUrl("whatsapp/calling#what-you-need"),
    docsUrl: "https://gologin.com/docs/api-reference/introduction/quickstart",
    setupSteps: [
      "Sign in to GoLogin and open Settings → API.",
      "Create a new API token and copy it. It is shown only once.",
      "Paste it below and save. Then add a calling number under Settings → WhatsApp → Calling numbers.",
    ],
    fields: [
      {
        key: "apiToken",
        label: "API token",
        help: "GoLogin → Settings → API → New token. Copy it right away; GoLogin shows it only once.",
        inputType: "password",
        required: true,
        secret: true,
      },
    ],
  },
  {
    // 改造新增：国内 B2B 的主渠道，替代原来的 LinkedIn。
    key: "wecom",
    name: "企业微信",
    description: "企业微信自建应用：加客户为外部联系人、发消息、接收回复。国内拓客的首选渠道。",
    enables: ["企微加好友与消息", "客户回复进 CRM"],
    websiteUrl: "https://work.weixin.qq.com/",
    iconUrl: "/Integrations - Icon/wecom.svg",
    docsUrl: "https://developer.work.weixin.qq.com/document/path/90664",
    setupSteps: [
      "企业微信管理后台「我的企业 → 企业信息」页面底部，复制「企业 ID」（corpId）。",
      "「应用管理 → 自建 → 创建应用」，填名称和 logo，创建后拿到 AgentId 和 Secret。",
      "进入刚建的应用，在「接收消息」里设置 API 接收 URL、Token、EncodingAESKey——URL 填本系统的 /api/webhooks/wecom。",
      "把企业 ID、AgentId、Secret、Token、EncodingAESKey 填到下面。",
    ],
    fields: [
      {
        key: "corpId",
        label: "企业 ID（corpId）",
        help: "企微管理后台 → 我的企业 → 企业信息，页面最下方的「企业 ID」。",
        inputType: "text",
        required: true,
        secret: false,
      },
      {
        key: "agentId",
        label: "AgentId",
        help: "应用管理 → 自建 → 你的应用 → 应用详情里的 AgentId（一串数字）。",
        inputType: "text",
        required: true,
        secret: false,
      },
      {
        key: "secret",
        label: "Secret",
        help: "应用详情页的 Secret，点「查看」获取。只显示一次，丢了要重置。",
        inputType: "password",
        required: true,
        secret: true,
      },
      {
        key: "callbackToken",
        label: "回调 Token",
        help: "应用详情 → 接收消息 → 设置 API 接收，自己定的 Token。留空则只发不收。",
        inputType: "text",
        required: false,
        secret: false,
      },
      {
        key: "callbackAesKey",
        label: "EncodingAESKey",
        help: "同一个设置页里的 EncodingAESKey（43 位）。留空则只发不收。",
        inputType: "password",
        required: false,
        secret: true,
      },
    ],
  },
];

/** OpenRouter is connected on the AI provider page; the Integrations page only shows its card. */
export const OPENROUTER_ICON_URL = "/Integrations - Icon/openrouter.svg";

/**
 * Where each integration is connected in Settings: the Connection page of
 * the channel it powers. Screens that need a connection link here rather than
 * hard-coding a settings path.
 */
export const PLATFORM_SETTINGS_HREF: Record<PlatformKey, string> = {
  google: "/settings/email-connection",
  unipile: "/settings/linkedin-connection",
  r2: "/settings/whatsapp-connection",
  gologin: "/settings/whatsapp-connection",
  wecom: "/settings/wecom-connection",
};

/** Where that page sits in the Settings sidebar, for messages. */
export const PLATFORM_SETTINGS_LABEL: Record<PlatformKey, string> = {
  google: "设置 → 邮件 → 连接配置",
  unipile: "设置 → 领英 → 连接配置",
  r2: "设置 → WhatsApp → 集成",
  gologin: "设置 → WhatsApp → 集成",
  wecom: "设置 → 企业微信 → 连接配置",
};

export function getPlatformIntegration(key: string): PlatformIntegration | null {
  return PLATFORM_INTEGRATIONS.find((integration) => integration.key === key) ?? null;
}

export function isPlatformKey(key: string): key is PlatformKey {
  return getPlatformIntegration(key) !== null;
}

/** What the settings UI receives about one platform — never a secret value. */
export type PlatformStatus = {
  key: PlatformKey;
  connected: boolean;
  /** Non-secret field values, for display and to prefill the edit form. */
  values: Record<string, string>;
  /** Secret fields that currently hold a value. */
  secretsSet: string[];
  verifiedAt: string | null;
  /** Unipile only: the outcome of registering its webhooks. */
  webhooks?: UnipileWebhookRegistration | null;
};

/** What happened when AgentSDR registered Unipile's webhooks for an organization. */
export type UnipileWebhookRegistration = {
  /** registered: all created. skipped: nothing to do yet (local address, no public URL). failed: Unipile refused. */
  status: "registered" | "skipped" | "failed";
  at: string;
  /** The public origin the webhook URLs point at. */
  origin?: string;
  /** One per registered webhook: our key and Unipile's webhook id. */
  items?: { key: string; id: string }[];
  /** Why it was skipped or failed, in words for the settings page. */
  message?: string;
};
