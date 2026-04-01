import React, { useState } from "react";
import GoogleWalletLinkModal from "./GoogleWalletLinkModal";

export default function GoogleWalletLinkButton({
  label = "Bind Google",
  onLinked,
  onStatusChange,
}: {
  label?: string;
  onLinked?: (info: { wallet: string; googleSub?: string; email?: string }) => void;
  onStatusChange?: (linked: boolean, info?: { wallet?: string; googleSub?: string; email?: string }) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="cw-btn cw-btnPrimary"
        onClick={() => setOpen(true)}
      >
        {label}
      </button>

      <GoogleWalletLinkModal
        open={open}
        onClose={() => setOpen(false)}
        onLinked={(info) => {
          onLinked?.(info);
          onStatusChange?.(true, info);
        }}
        onStatusChange={onStatusChange}
      />
    </>
  );
}
