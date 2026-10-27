import CrmKnowledgeClient from "@/components/crm/CrmKnowledgeClient";

export const metadata = { title: "知识库" };
export const dynamic = "force-dynamic";

/** CrmKnowledgeClient renders the section header, since its "Add document" action opens state it holds. */
export default function KnowledgePage() {
  return <CrmKnowledgeClient />;
}
