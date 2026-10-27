import "server-only";

import { channelRules } from "@/lib/channels/rules.server";
import { DEFAULT_PHONE_COUNTRY } from "./index";

/**
 * 当前组织默认按哪个国家解析不带 "+" 的号码：组织自己的设置
 * （设置 → 基本设置 → 默认电话国家）→ 实例的 DEFAULT_PHONE_COUNTRY → 中国大陆。
 */
export async function organizationPhoneCountry(): Promise<string> {
  const { defaultPhoneCountry } = await channelRules("general");
  return defaultPhoneCountry || process.env.DEFAULT_PHONE_COUNTRY || DEFAULT_PHONE_COUNTRY;
}
