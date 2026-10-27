/**
 * 企业搜索的数据源抽象。
 *
 * 改造前「找客户」= 全球 Shopify 独立站店铺库（`/domains` 页面），国内用不了。
 * 换成就地取材的两层：
 *
 *   1. `local`  —— 搜**自己库里的公司**。不需要任何账号，今天就能用；作用是把
 *                  已有的名单翻出来，免得重复录入。
 *   2. `qcc`    —— 企查查开放平台，搜**全国企业**。需要企业账号 + API key。
 *
 * 同一个界面、同一种结果形状，配置了企查查就自动用它，没配置就搜本地。
 * 这样"接入数据源"这件事不影响销售今天能不能干活。
 *
 * 关于企查查的接口：签名与字段按公开文档实现（`Token` = MD5(key+timestamp+secret)
 * 大写，请求带 `key` / `timestamp` 参数）。**还没有用真实账号验证过**，所以：
 * 配置缺失时不会走到这里；走到这里但调用失败时，会把原始错误带回去，方便对照
 * 官方文档校准，而不是静默返回空列表。
 */

export type CompanyHit = {
  /** 稳定标识：企查查用统一社会信用代码，本地用 company.id。 */
  key: string;
  name: string;
  /** 统一社会信用代码 / 注册号。 */
  creditCode: string | null;
  /** 省市区，拼成一行。 */
  region: string | null;
  /** 行业分类。 */
  industry: string | null;
  /** 法定代表人。 */
  legalPerson: string | null;
  /** 成立日期，YYYY-MM-DD。 */
  foundedAt: string | null;
  /** 注册资本，原样字符串（"500万元人民币"）。 */
  registeredCapital: string | null;
  /** 公开电话（工商公示），可能有多个。 */
  phones: string[];
  /** 经营范围摘要。 */
  scope: string | null;
  /** 经营状态：存续 / 注销 / 吊销。 */
  status: string | null;
  /** 是否已经在我们的线索库里。 */
  inLibrary: boolean;
};

export type SearchResult = {
  source: "local" | "qcc";
  total: number;
  hits: CompanyHit[];
  /** 数据源侧给的提示：没配置、被限流、字段为空之类。 */
  notice: string | null;
};
