import * as React from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Stack,
  Typography,
  Paper,
  IconButton,
  Box,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import QrCode2Icon from "@mui/icons-material/QrCode2";
import { QRCodeSVG } from "qrcode.react";

function getRegisterUrl() {
  try {
    return `${window.location.origin}/#/register-wallet-google`;
  } catch {
    return "/#/register-wallet-google";
  }
}

async function copyText(text: string) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

export type UnregisteredGooglePromptProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  message?: string;
  registerUrl?: string;
  googleEmail?: string;
  googleName?: string;
  googleSub?: string;
  buttonText?: string;
  onCopied?: () => void;
};

export default function UnregisteredGooglePrompt({
  open,
  onClose,
  title = "Wallet registration required",
  message = "This Google account is not linked to a wallet-backed cashier account yet. Register first, then come back and sign in again.",
  registerUrl,
  googleEmail,
  googleName,
  googleSub,
  buttonText = "Register",
  onCopied,
}: UnregisteredGooglePromptProps) {
  const targetUrl = React.useMemo(() => registerUrl || getRegisterUrl(), [registerUrl]);

  const label = React.useMemo(() => {
    return googleName || googleEmail || googleSub || "";
  }, [googleEmail, googleName, googleSub]);

  function openRegister() {
    try {
      window.open(targetUrl, "_blank", "noopener,noreferrer");
    } catch {
      window.location.href = targetUrl;
    }
  }

  async function handleCopy() {
    try {
      await copyText(targetUrl);
      onCopied?.();
    } catch {
      // ignore
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      PaperProps={{
        sx: {
          borderRadius: 3,
          bgcolor: "rgba(12,16,24,0.98)",
          color: "rgba(240,247,255,0.94)",
          border: "1px solid rgba(255,255,255,0.14)",
        },
      }}
    >
      <DialogTitle sx={{ fontWeight: 1000, pr: 6 }}>
        {title}
        <IconButton
          onClick={onClose}
          sx={{ position: "absolute", right: 10, top: 10, color: "rgba(240,247,255,0.94)" }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers sx={{ borderColor: "rgba(255,255,255,0.12)" }}>
        <Stack spacing={1.4}>
          <Typography sx={{ color: "rgba(240,247,255,0.82)", lineHeight: 1.55 }}>
            {message}
          </Typography>

          {label ? (
            <Paper
              variant="outlined"
              sx={{
                p: 1.2,
                borderRadius: 2,
                borderColor: "rgba(255,255,255,0.14)",
                background: "rgba(255,255,255,0.05)",
              }}
            >
              <Typography sx={{ fontWeight: 900, mb: 0.5 }}>Google account</Typography>
              <Typography sx={{ color: "rgba(240,247,255,0.76)", overflowWrap: "anywhere" }}>
                {label}
              </Typography>
            </Paper>
          ) : null}

          <Paper
            variant="outlined"
            sx={{
              p: 1.4,
              borderRadius: 2,
              borderColor: "rgba(255,255,255,0.14)",
              background: "rgba(255,255,255,0.04)",
            }}
          >
            <Stack spacing={1.2} alignItems="center">
              <Box
                sx={{
                  background: "#fff",
                  p: 1.2,
                  borderRadius: 2,
                  width: "fit-content",
                }}
              >
                <QRCodeSVG value={targetUrl} size={190} />
              </Box>

              <Typography
                sx={{
                  fontSize: 12,
                  color: "rgba(240,247,255,0.68)",
                  textAlign: "center",
                  overflowWrap: "anywhere",
                }}
              >
                {targetUrl}
              </Typography>
            </Stack>
          </Paper>

          <Typography sx={{ color: "rgba(240,247,255,0.68)", fontSize: 13, lineHeight: 1.55 }}>
            Open the registration page, connect your wallet, link Google, then return here and sign in again.
          </Typography>
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 2, py: 1.5, justifyContent: "space-between", gap: 1, flexWrap: "wrap" }}>
        <Button onClick={onClose} sx={{ color: "rgba(240,247,255,0.94)", fontWeight: 900 }}>
          Close
        </Button>

        <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ width: { xs: "100%", sm: "auto" } }}>
          <Button
            variant="outlined"
            startIcon={<ContentCopyIcon />}
            onClick={() => void handleCopy()}
            sx={{
              fontWeight: 900,
              color: "rgba(240,247,255,0.94)",
              borderColor: "rgba(255,255,255,0.16)",
            }}
            fullWidth
          >
            Copy Link
          </Button>

          <Button
            variant="outlined"
            startIcon={<QrCode2Icon />}
            onClick={openRegister}
            sx={{
              fontWeight: 900,
              color: "rgba(240,247,255,0.94)",
              borderColor: "rgba(255,255,255,0.16)",
            }}
            fullWidth
          >
            Open Setup
          </Button>

          <Button
            variant="contained"
            startIcon={<OpenInNewIcon />}
            onClick={openRegister}
            sx={{ fontWeight: 900 }}
            fullWidth
          >
            {buttonText}
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
