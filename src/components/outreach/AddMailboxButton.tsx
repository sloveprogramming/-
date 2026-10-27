"use client";

import { useState } from "react";
import { RiAddLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import ConnectMailboxDialog from "./ConnectMailboxDialog";

export default function AddMailboxButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button.Root variant="primary" mode="filled" size="small" onClick={() => setOpen(true)}>
        <Button.Icon as={RiAddLine} />
        添加发信邮箱
      </Button.Root>
      {open && <ConnectMailboxDialog onClose={() => setOpen(false)} />}
    </>
  );
}
