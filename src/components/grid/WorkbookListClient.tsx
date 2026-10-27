"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiDeleteBinLine,
  RiFolder3Line,
  RiFolderTransferLine,
  RiMoreLine,
  RiPencilLine,
  RiSearchLine,
} from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Input from "@/components/alignui/input";
import * as SegmentedControl from "@/components/alignui/segmented-control";
import * as Table from "@/components/alignui/table";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { EmptyState } from "@/components/page/EmptyState";
import { PageContainer, PageHeader } from "@/components/page/PageHeader";
import { cn } from "@/utils/cn";
import type { FolderCrumb, FolderSummary } from "@/lib/grid/folders";
import type { GridFolder } from "@/lib/grid/schema";
import type { WorkbookSummary } from "@/lib/grid/workbooks";
import { useDialogs } from "@/components/DialogProvider";
import MoveToFolderDialog from "./MoveToFolderDialog";
import NewWorkbookDialog from "./NewWorkbookDialog";
import WorkbookIcon from "./WorkbookIcon";

// There is no favoriting yet (no column, no endpoint), so there is no
// Favorites view — a tab that can only ever be empty is a control that lies.
type View = "all" | "recents";

const VIEW_LABEL: Record<View, string> = { all: "All", recents: "Recents" };

/** Which row the shared rename/move/delete dialogs are currently acting on. */
type Target =
  | { kind: "folder"; id: string; name: string; parentId: string | null }
  | { kind: "workbook"; id: string; name: string; folderId: string | null };

function formatDate(value: Date | string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/**
 * "0 tables · 0 rows" was both wrong (the counts never loaded) and useless
 * once fixed — an empty workbook is worth saying in words, and real counts
 * are worth thousands separators.
 */
function workbookContents(workbook: WorkbookSummary) {
  if (workbook.tableCount === 0) return "Empty workbook";
  if (workbook.rowCount === 0) return `${plural(workbook.tableCount, "table")} · no rows yet`;
  return `${plural(workbook.tableCount, "table")} · ${plural(workbook.rowCount, "row")}`;
}

function folderContents(folder: FolderSummary) {
  const parts: string[] = [];
  if (folder.folderCount) parts.push(plural(folder.folderCount, "folder"));
  if (folder.workbookCount) parts.push(plural(folder.workbookCount, "workbook"));
  return parts.length ? parts.join(" · ") : "Empty folder";
}

async function send(url: string, method: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? "Something went wrong");
  return data;
}

export default function WorkbookListClient({
  folderId,
  breadcrumbs,
  folders,
  workbooks,
  allFolders,
}: {
  /** The folder being viewed. NULL = the root of All Files. */
  folderId: string | null;
  breadcrumbs: FolderCrumb[];
  folders: FolderSummary[];
  workbooks: WorkbookSummary[];
  /** Every folder in the workspace — the destinations for "Move to…". */
  allFolders: GridFolder[];
}) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const dialogs = useDialogs();
  const [view, setView] = useState<View>("all");
  const [search, setSearch] = useState("");
  const [newWorkbookOpen, setNewWorkbookOpen] = useState(false);
  const [moving, setMoving] = useState<Target | null>(null);
  const [dragging, setDragging] = useState<Target | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragError, setDragError] = useState<string | null>(null);

  const here = breadcrumbs.at(-1) ?? null;
  const query = search.trim().toLowerCase();

  const visibleFolders = useMemo(() => {
    // Folders are locations, not documents — "recents" is about files, so folders stay pinned to the top of every view.
    return query ? folders.filter((f) => f.name.toLowerCase().includes(query)) : folders;
  }, [folders, query]);

  const visibleWorkbooks = useMemo(() => {
    const matching = query
      ? workbooks.filter((workbook) => workbook.name.toLowerCase().includes(query))
      : [...workbooks];
    return view === "recents"
      ? matching.sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime())
      : matching;
  }, [query, view, workbooks]);

  const isEmpty = !visibleFolders.length && !visibleWorkbooks.length;
  const nothingYet = !folders.length && !workbooks.length;
  const counts: Record<View, number> = { all: folders.length + workbooks.length, recents: workbooks.length };
  const dropClass = "bg-primary-alpha-10 text-primary-base ring-1 ring-primary-base";

  /**
   * A folder plus everything nested under it. Moving a folder into its own
   * subtree would cut that subtree off from the root, so these are the
   * destinations neither the picker nor a drop may target.
   */
  const descendantsOf = useCallback((folderId: string) => {
    const blocked = new Set([folderId]);
    // allFolders is small and flat, so a few passes beat building a tree.
    for (let pass = 0; pass < allFolders.length; pass += 1) {
      let grew = false;
      for (const folder of allFolders) {
        if (folder.parentId && blocked.has(folder.parentId) && !blocked.has(folder.id)) {
          blocked.add(folder.id);
          grew = true;
        }
      }
      if (!grew) break;
    }
    return blocked;
  }, [allFolders]);

  const moveExclusions = useMemo(
    () => (moving?.kind === "folder" ? [...descendantsOf(moving.id)] : []),
    [descendantsOf, moving],
  );

  /** Whether `target` (a folder id, or null for the root) can receive `item`. */
  const canDropOn = useCallback(
    (item: Target, target: string | null) => {
      const parent = item.kind === "folder" ? item.parentId : item.folderId;
      if (parent === target) return false;
      if (item.kind === "folder" && target !== null && descendantsOf(item.id).has(target)) {
        return false;
      }
      return true;
    },
    [descendantsOf],
  );

  const moveTo = useCallback(
    async (item: Target, target: string | null) => {
      setDragError(null);
      try {
        if (item.kind === "folder") {
          await send(`/api/grid/folders/${item.id}`, "PATCH", { parentId: target });
        } else {
          await send(`/api/grid/workbooks/${item.id}`, "PATCH", { folderId: target });
        }
        startTransition(() => router.refresh());
      } catch (cause) {
        setDragError(cause instanceof Error ? cause.message : "Could not move that item");
      }
    },
    [router],
  );

  /**
   * Drop-target wiring shared by folder rows and the breadcrumb.
   *
   * onDragOver must call preventDefault() for a drop to be allowed at all —
   * without it the browser rejects every drop silently.
   */
  function dropZone(target: string | null) {
    return {
      onDragOver: (event: React.DragEvent) => {
        if (!dragging || !canDropOn(dragging, target)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropTarget(target ?? "root");
      },
      onDragLeave: () => {
        setDropTarget((current) => (current === (target ?? "root") ? null : current));
      },
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        const item = dragging;
        setDragging(null);
        setDropTarget(null);
        if (item && canDropOn(item, target)) void moveTo(item, target);
      },
    };
  }

  /** Makes a row draggable. The inner Link needs draggable={false} too, or
   *  the browser drags its URL instead of the row. */
  function dragSource(item: Target) {
    return {
      draggable: true,
      onDragStart: (event: React.DragEvent) => {
        setDragging(item);
        event.dataTransfer.effectAllowed = "move";
        // Firefox ignores a drag that sets no data.
        event.dataTransfer.setData("text/plain", item.id);
      },
      onDragEnd: () => {
        setDragging(null);
        setDropTarget(null);
      },
    };
  }

  function hrefFor(id: string | null) {
    return id ? `/tables?folder=${id}` : "/tables";
  }

  async function createFolder() {
    const name = await dialogs.prompt({
      title: "New folder",
      description: here ? `It will be created inside “${here.name}”.` : undefined,
      label: "Folder name",
      placeholder: "Untitled folder",
      confirmLabel: "Create",
    });
    if (!name?.trim()) return;
    try {
      await send("/api/grid/folders", "POST", { name: name.trim(), parentId: folderId });
      startTransition(() => router.refresh());
    } catch (cause) {
      setDragError(cause instanceof Error ? cause.message : "Could not create that folder");
    }
  }

  async function rename(target: Target) {
    const name = await dialogs.prompt({
      title: target.kind === "folder" ? "Rename folder" : "Rename workbook",
      label: "Name",
      defaultValue: target.name,
      confirmLabel: "Rename",
    });
    if (!name?.trim() || name.trim() === target.name) return;
    const base = target.kind === "folder" ? "/api/grid/folders" : "/api/grid/workbooks";
    try {
      await send(`${base}/${target.id}`, "PATCH", { name: name.trim() });
      startTransition(() => router.refresh());
    } catch (cause) {
      setDragError(cause instanceof Error ? cause.message : "Could not rename that item");
    }
  }

  async function move(destination: string | null) {
    if (!moving) return;
    if (moving.kind === "folder") {
      await send(`/api/grid/folders/${moving.id}`, "PATCH", { parentId: destination });
    } else {
      await send(`/api/grid/workbooks/${moving.id}`, "PATCH", { folderId: destination });
    }
    setMoving(null);
    startTransition(() => router.refresh());
  }

  async function remove(target: Target) {
    const ok = await dialogs.confirm({
      title: target.kind === "folder" ? "Delete folder?" : "Delete workbook?",
      description:
        target.kind === "folder"
          ? `“${target.name}” and any folders inside it will be deleted. Workbooks filed in them are not deleted — they move back to All Files.`
          : `“${target.name}” and every table, column and row inside it will be permanently deleted. This cannot be undone.`,
      confirmLabel: target.kind === "folder" ? "Delete folder" : "Delete workbook",
      variant: "error",
    });
    if (!ok) return;

    const base = target.kind === "folder" ? "/api/grid/folders" : "/api/grid/workbooks";
    try {
      await send(`${base}/${target.id}`, "DELETE");
      startTransition(() => router.refresh());
    } catch (cause) {
      setDragError(cause instanceof Error ? cause.message : "Could not delete that item");
    }
  }

  function rowMenu(target: Target) {
    return (
      <Dropdown.Root>
        <Dropdown.Trigger asChild>
          <Button.Root variant="neutral" mode="ghost" size="xsmall" aria-label={`Actions for ${target.name}`}>
            <Button.Icon as={RiMoreLine} />
          </Button.Root>
        </Dropdown.Trigger>
        <Dropdown.Content align="end">
          <Dropdown.Item onSelect={() => void rename(target)}>
            <Dropdown.ItemIcon as={RiPencilLine} />Rename
          </Dropdown.Item>
          <Dropdown.Item onSelect={() => setMoving(target)}>
            <Dropdown.ItemIcon as={RiFolderTransferLine} />Move to folder
          </Dropdown.Item>
          <Dropdown.Separator />
          <Dropdown.Item destructive onSelect={() => void remove(target)}>
            <Dropdown.ItemIcon as={RiDeleteBinLine} />Delete
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Root>
    );
  }

  /** Shared by every row: keyboard-reachable, opens on Enter, draggable. */
  function rowProps(href: string, item: Target) {
    return {
      tabIndex: 0,
      onClick: () => router.push(href),
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.target === event.currentTarget && event.key === "Enter") router.push(href);
      },
      ...dragSource(item),
    };
  }

  const newMenu = (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <Button.Root variant="primary" mode="filled" size="small">
          <Button.Icon as={RiAddLine} />
          New
          <Button.Icon as={RiArrowDownSLine} />
        </Button.Root>
      </Dropdown.Trigger>
      <Dropdown.Content align="end" className="w-[220px]">
        <Dropdown.Item onSelect={() => void createFolder()}>
          <Dropdown.ItemIcon as={RiFolder3Line} />Folder
        </Dropdown.Item>
        <Dropdown.Item onSelect={() => setNewWorkbookOpen(true)}>
          <Dropdown.ItemIcon as={WorkbookIcon} />Workbook
        </Dropdown.Item>
      </Dropdown.Content>
    </Dropdown.Root>
  );

  const stop = {
    onClick: (event: React.SyntheticEvent) => event.stopPropagation(),
    onKeyDown: (event: React.SyntheticEvent) => event.stopPropagation(),
  };

  return (
    <PageContainer>
      <PageHeader
        title={here?.name ?? "Tables"}
        description={
          breadcrumbs.length > 0 ? (
            <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1">
              {/* Crumbs are drop targets too — otherwise there is no way
                  to drag something back OUT of the folder you are in. */}
              <Link
                href="/tables"
                draggable={false}
                {...dropZone(null)}
                className={cn("rounded px-1 py-0.5 transition hover:text-text-strong-950", dropTarget === "root" && dropClass)}
              >
                全部文件
              </Link>
              {breadcrumbs.map((crumb, index) => (
                <span key={crumb.id} className="flex items-center gap-1">
                  <RiArrowRightSLine className="size-3.5 text-text-soft-400" aria-hidden="true" />
                  {index === breadcrumbs.length - 1 ? (
                    <span className="text-text-strong-950">{crumb.name}</span>
                  ) : (
                    <Link
                      href={hrefFor(crumb.id)}
                      draggable={false}
                      {...dropZone(crumb.id)}
                      className={cn("rounded px-1 py-0.5 transition hover:text-text-strong-950", dropTarget === crumb.id && dropClass)}
                    >
                      {crumb.name}
                    </Link>
                  )}
                </span>
              ))}
            </nav>
          ) : (
            "存放数据表、导入结果与采集数据的工作簿和文件夹。"
          )
        }
        actions={newMenu}
      />

      <Frame className="mt-6">
        <FrameHeader
          title={here ? "当前文件夹" : "全部文件"}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl.Root value={view} onValueChange={(v) => setView(v as View)}>
                <SegmentedControl.List className="w-auto">
                  {(Object.keys(VIEW_LABEL) as View[]).map((item) => (
                    <SegmentedControl.Trigger key={item} value={item} className="gap-1.5 px-3">
                      {VIEW_LABEL[item]}
                      <span className="tabular-nums text-text-soft-400">{counts[item]}</span>
                    </SegmentedControl.Trigger>
                  ))}
                </SegmentedControl.List>
              </SegmentedControl.Root>
              <Input.Root size="small" className="w-56">
                <Input.Wrapper>
                  <Input.Icon as={RiSearchLine} />
                  <Input.Input type="search" aria-label="搜索文件" placeholder="搜索文件…" value={search} onChange={(event) => setSearch(event.target.value)} />
                </Input.Wrapper>
              </Input.Root>
            </div>
          }
        />
        <FramePanel className="overflow-x-auto p-2 sm:p-2">
          {dragError && (
            <p role="alert" className="mb-2 rounded-lg bg-error-lighter px-4 py-2 text-paragraph-sm text-error-base">{dragError}</p>
          )}
          {isEmpty ? (
            nothingYet ? (
              <EmptyState
                icon={WorkbookIcon}
                title={here ? `“${here.name}” is empty` : "还没有工作簿"}
                description="新建一个工作簿、导入一份表格，或者建个文件夹来整理它们。"
                action={newMenu}
              />
            ) : (
              <EmptyState
                icon={RiSearchLine}
                title="Nothing matches that search"
                description="Try a different name, or clear the search."
                action={
                  <Button.Root variant="neutral" mode="stroke" size="small" onClick={() => setSearch("")}>
                    Clear search
                  </Button.Root>
                }
              />
            )
          ) : (
            <div aria-busy={refreshing} className={cn("transition-opacity", refreshing && "opacity-60")}>
              <Table.Root className="min-w-[640px]">
                <Table.Header>
                  <Table.Row>
                    <Table.Head scope="col" className="px-4">Name</Table.Head>
                    <Table.Head scope="col" className="w-36 px-4">Created</Table.Head>
                    <Table.Head scope="col" className="w-36 px-4">Last updated</Table.Head>
                    <Table.Head scope="col" className="w-16 px-4"><span className="sr-only">Actions</span></Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body spacing={4}>
                  {visibleFolders.map((folder) => {
                    const item: Target = { kind: "folder", id: folder.id, name: folder.name, parentId: folder.parentId };
                    const isDropTarget = dropTarget === folder.id;
                    return (
                      <Table.Row
                        key={folder.id}
                        {...rowProps(hrefFor(folder.id), item)}
                        {...dropZone(folder.id)}
                        className={cn(
                          "cursor-grab outline-none focus-visible:[&>td]:bg-bg-weak-50 active:cursor-grabbing",
                          isDropTarget && "[&>td]:bg-primary-alpha-10",
                          dragging?.id === folder.id && "opacity-40",
                        )}
                      >
                        <Table.Cell className="h-16 px-4">
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-bg-weak-50 ring-1 ring-inset ring-stroke-soft-200">
                              <RiFolder3Line className="size-[18px] text-warning-base" aria-hidden="true" />
                            </span>
                            <div className="min-w-0">
                              <Link href={hrefFor(folder.id)} draggable={false} onClick={(event) => event.stopPropagation()} title={folder.name} className="block truncate text-label-sm text-text-strong-950 outline-none hover:underline focus-visible:underline">
                                {folder.name}
                              </Link>
                              <p className={cn("mt-0.5 truncate text-paragraph-xs", isDropTarget ? "text-primary-base" : "text-text-sub-600")}>
                                {isDropTarget ? "Drop to move here" : folderContents(folder)}
                              </p>
                            </div>
                          </div>
                        </Table.Cell>
                        <Table.Cell className="whitespace-nowrap px-4 text-paragraph-sm text-text-sub-600">{formatDate(folder.createdAt)}</Table.Cell>
                        <Table.Cell className="whitespace-nowrap px-4 text-paragraph-sm text-text-sub-600">{formatDate(folder.updatedAt)}</Table.Cell>
                        <Table.Cell className="px-4" {...stop}>
                          <div className="flex justify-end">{rowMenu(item)}</div>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}

                  {visibleWorkbooks.map((workbook) => {
                    const item: Target = { kind: "workbook", id: workbook.id, name: workbook.name, folderId: workbook.folderId };
                    return (
                      <Table.Row
                        key={workbook.id}
                        {...rowProps(`/tables/${workbook.id}`, item)}
                        className={cn(
                          "cursor-grab outline-none focus-visible:[&>td]:bg-bg-weak-50 active:cursor-grabbing",
                          dragging?.id === workbook.id && "opacity-40",
                        )}
                      >
                        <Table.Cell className="h-16 px-4">
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-bg-weak-50 ring-1 ring-inset ring-stroke-soft-200">
                              <WorkbookIcon className="size-[18px]" />
                            </span>
                            <div className="min-w-0">
                              <Link href={`/tables/${workbook.id}`} draggable={false} onClick={(event) => event.stopPropagation()} title={workbook.name} className="block truncate text-label-sm text-text-strong-950 outline-none hover:underline focus-visible:underline">
                                {workbook.name}
                              </Link>
                              <p className="mt-0.5 truncate text-paragraph-xs text-text-sub-600">{workbookContents(workbook)}</p>
                            </div>
                          </div>
                        </Table.Cell>
                        <Table.Cell className="whitespace-nowrap px-4 text-paragraph-sm text-text-sub-600">{formatDate(workbook.createdAt)}</Table.Cell>
                        <Table.Cell className="whitespace-nowrap px-4 text-paragraph-sm text-text-sub-600">{formatDate(workbook.updatedAt)}</Table.Cell>
                        <Table.Cell className="px-4" {...stop}>
                          <div className="flex justify-end">{rowMenu(item)}</div>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Root>
            </div>
          )}
        </FramePanel>
        {folders.length + workbooks.length > 0 && <FrameFooter>Drag a row onto a folder, or a breadcrumb, to file it there.</FrameFooter>}
      </Frame>

      <NewWorkbookDialog
        open={newWorkbookOpen}
        folderId={folderId}
        onClose={() => setNewWorkbookOpen(false)}
        onCreated={(workbookId) => {
          setNewWorkbookOpen(false);
          router.push(`/tables/${workbookId}`);
        }}
      />

      <MoveToFolderDialog
        open={moving !== null}
        title={moving?.kind === "folder" ? "Move folder" : "Move workbook"}
        itemName={moving?.name ?? ""}
        currentFolderId={moving?.kind === "folder" ? moving.parentId : (moving?.folderId ?? null)}
        folders={allFolders}
        excludeIds={moveExclusions}
        onClose={() => setMoving(null)}
        onMove={move}
      />
    </PageContainer>
  );
}
