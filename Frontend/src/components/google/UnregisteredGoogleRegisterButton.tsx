import * as React from "react";
import { Button } from "@mui/material";
import UnregisteredGooglePrompt from "./UnregisteredGooglePrompt";

export type UnregisteredGoogleRegisterButtonProps = {
  label?: string;
  title?: string;
  message?: string;
  registerUrl?: string;
  googleEmail?: string;
  googleName?: string;
  googleSub?: string;
  variant?: "text" | "outlined" | "contained";
  fullWidth?: boolean;
  onCopied?: () => void;
};

export default function UnregisteredGoogleRegisterButton({
  label = "Register",
  title,
  message,
  registerUrl,
  googleEmail,
  googleName,
  googleSub,
  variant = "contained",
  fullWidth,
  onCopied,
}: UnregisteredGoogleRegisterButtonProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button
        variant={variant}
        fullWidth={fullWidth}
        onClick={() => setOpen(true)}
        sx={{ fontWeight: 950, borderRadius: 2 }}
      >
        {label}
      </Button>

      <UnregisteredGooglePrompt
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        message={message}
        registerUrl={registerUrl}
        googleEmail={googleEmail}
        googleName={googleName}
        googleSub={googleSub}
        onCopied={onCopied}
      />
    </>
  );
}
