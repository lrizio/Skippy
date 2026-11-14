#!/usr/bin/env python3
"""Generates docs/Skippy for Linux User Guide.pdf. Reuses the layout helpers of build_apple_guide.py.
Usage (from the project root):  python build_linux_guide.py     (requires reportlab + pillow)
"""
from __future__ import annotations

import os

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Spacer, Table, TableStyle

import build_apple_guide as g
from build_apple_guide import P, bullets, numbered, table, box, warn, shots, style_title, style_subtitle, \
    style_h1, style_h2, style_h3, style_code, CONTENT_W, MUTED, VERSION

APP = "Skippy for Linux"
OUT_PATH = os.path.join(g.ROOT, "docs", f"{APP} User Guide.pdf")
TAG = f"linux-v{VERSION}"


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(0.65 * inch, 0.3 * inch, f"{APP} User Guide  -  version {VERSION} (test release)")
    canvas.drawRightString(LETTER[0] - 0.65 * inch, 0.3 * inch, f"Page {doc.page}")
    canvas.restoreState()


def build():
    doc = SimpleDocTemplate(OUT_PATH, pagesize=LETTER, title=f"{APP} User Guide", author="VK3EI",
                            topMargin=0.45 * inch, bottomMargin=0.55 * inch,
                            leftMargin=0.65 * inch, rightMargin=0.65 * inch)
    f = []
    f.append(P(f"{APP} User Guide", style_title))
    f.append(P(f"Install and use Skippy on a Linux desktop  -  version {VERSION}", style_subtitle))
    f.append(Table([[""]], colWidths=[CONTENT_W], rowHeights=[1],
                   style=TableStyle([("LINEBELOW", (0, 0), (-1, -1), 1, colors.HexColor("#cccccc"))])))
    f.append(Spacer(1, 8))
    f.append(P(
        "Skippy is group video calling for up to 10 people: audio, video, chat, file transfer and direct calls. "
        "The Linux app is the same desktop app as on Windows. Like every Skippy app it connects to a Skippy server "
        "run by someone in your group, so you need that server's address and an account on it."))
    f.append(warn(
        "<b>This is a test release.</b> The Linux builds start and run on GitHub's test machines, but they have not "
        "been used in a real call on a real desktop yet. If something doesn't work, please report it - see "
        "<b>Reporting a problem</b> at the end."))

    f.append(P("What you need", style_h2))
    f.append(bullets([
        "A 64-bit Linux desktop with a recent distribution (Ubuntu 22.04 / Debian 12 / Fedora 38 or newer). "
        "<b>x86-64</b> PCs and <b>arm64</b> machines (for example a Raspberry Pi 4 or 5 running 64-bit Linux) are both supported.",
        "The <b>server address</b> from whoever runs your Skippy server, e.g. <b>100.64.0.10:8470</b>. If it starts with "
        "<b>100.</b> it is a Tailscale address: install Tailscale (tailscale.com/download), sign in to the server's account and run "
        "<b>tailscale up</b>.",
        f"One file from the <b>latest release</b> at github.com/lrizio/Skippy/releases: the <b>.AppImage</b> (works on any "
        "distribution) or the <b>.deb</b> (Debian, Ubuntu, Mint, Raspberry Pi OS) for your processor "
        "(<b>x86_64/amd64</b> for ordinary PCs, <b>arm64</b> for ARM).",
    ]))

    f.append(P("Install - choose one", style_h2))
    f.append(P("Option A: AppImage (any distribution)", style_h3))
    f.append(numbered([
        f"Download <b>Skippy-{VERSION}-linux-x86_64.AppImage</b> (or <b>-arm64.AppImage</b>).",
        "Make it runnable: right-click it, <b>Properties, Permissions, Allow executing file as program</b> - or in a terminal:",
    ]))
    f.append(P(f"chmod +x Skippy-{VERSION}-linux-x86_64.AppImage<br/>./Skippy-{VERSION}-linux-x86_64.AppImage", style_code))
    f.append(P("An AppImage doesn't install anything; keep it somewhere like <b>~/Applications</b>. To update, download "
               "the new file and delete the old one. If it won't start because of <b>FUSE</b>, install it "
               "(<b>sudo apt install libfuse2</b> on Ubuntu 22.04/Debian; <b>libfuse2t64</b> on Ubuntu 24.04), or run "
               "it with <b>--appimage-extract-and-run</b>."))
    f.append(P("Option B: .deb package (Debian / Ubuntu family)", style_h3))
    f.append(P(f"sudo apt install ./Skippy-{VERSION}-linux-amd64.deb", style_code))
    f.append(P("(Use the <b>-arm64.deb</b> file on an ARM machine.) Skippy then appears in your applications menu, and "
               "<b>skippy</b> starts it from a terminal. Remove it with <b>sudo apt remove skippy</b>."))
    f.append(warn(
        "<b>\"The SUID sandbox helper binary was not configured correctly\"</b> (or the AppImage closes at once on "
        "Ubuntu 23.10 / 24.04 and newer). Ubuntu now restricts the sandbox that Electron apps use. The .deb "
        "normally works as it is. For the AppImage, either run it with <b>--no-sandbox</b>, or allow it once with: "
        "<b>sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0</b> (this lowers a system-wide protection, so "
        "prefer the .deb or <b>--no-sandbox</b> if you are unsure)."))

    f.append(P("First start", style_h2))
    f.append(numbered([
        "Start <b>Skippy</b>. On the login screen open <b>Server</b> and type the server address (<b>ws://</b> at the front is optional).",
        "Create an account or log in; save the <b>recovery key</b> - it is the only way back in if you forget your password.",
        "Allow camera and microphone if your desktop asks (Flatpak/Snap-style prompts only; a normal install uses them directly).",
    ]))
    f.append(shots(g.DESK, [("login.png", "Login screen (Windows shown; the Linux window is identical)."),
                            ("lobby.png", "The lobby: preview, devices, rooms and who is online.")], 3.3 * inch))

    f.append(P("Linux specifics", style_h2))
    f.append(table([
        ["Topic", "On Linux"],
        ["Tray icon / closing the window",
         "Skippy sits in the system tray; the window's close button <b>hides</b> it so calls can still come in. "
         "<b>GNOME hides tray icons by default</b>: install the <i>AppIndicator and KStatusNotifierItem Support</i> extension "
         "(Ubuntu has it built in) to see it. Without a tray you can always bring the window back by starting Skippy "
         "again, and quit it from the tray menu or with <b>Ctrl+Q</b>."],
        ["Start at login", "Tray menu, <b>Start when I sign in to this computer</b>. Skippy then starts hidden."],
        ["Screen sharing",
         "Click <b>Share</b>. On <b>X11</b> pick a screen or window in Skippy's list. On <b>Wayland</b> (the default on "
         "Ubuntu, Fedora) your desktop shows its own picker through <b>PipeWire</b>; this needs "
         "<b>xdg-desktop-portal</b> and the portal for your desktop (<b>xdg-desktop-portal-gnome</b> or <b>-kde</b>). "
         "If sharing fails, try starting Skippy with <b>--ozone-platform=x11</b>."],
        ["Camera / microphone / speaker", "Pick them under <b>Devices</b>. A camera must be a normal V4L2 webcam (<b>/dev/video0</b>); "
         "you need to be allowed to use it (usually automatic on a desktop login)."],
        ["Tailscale warning", "If the server is on Tailscale and it is off, Skippy shows a banner; the button runs <b>tailscale up</b> "
         "(needs <b>tailscale set --operator=$USER</b> once if it asks for sudo)."],
        ["Recording and transcripts",
         "<b>Record</b> saves one audio track per speaker to <b>~/Documents/Skippy Recordings</b>. Transcripts need the "
         "<b>whisper.cpp</b> speech engine: build it (github.com/ggml-org/whisper.cpp) and put <b>whisper-cli</b> on your "
         "PATH or in <b>~/.local/bin</b>; then Skippy's transcript setup downloads the language model (about 190 MB) once."],
    ], [1.7, 5.5]))

    f.append(P("Running the server on Linux", style_h2))
    f.append(P(
        "The server runs well on Linux (a small VPS, a Raspberry Pi, a home server). Install Node.js 22.13 or newer, download "
        "<b>Skippy-Server-&lt;version&gt;.zip</b> from the Releases page (the newest one that has it), unzip, and in that folder:"))
    f.append(P("npm install<br/>node server.js", style_code))
    f.append(P("It listens on port <b>8470</b> and keeps its data in <b>skippy.db</b> next to it. To keep it running, a "
               "systemd service works (example, untested - adjust the user and paths):"))
    f.append(P("# /etc/systemd/system/skippy-server.service<br/>"
               "[Unit]<br/>Description=Skippy server<br/>After=network-online.target<br/>"
               "[Service]<br/>User=skippy<br/>WorkingDirectory=/opt/skippy-server<br/>"
               "ExecStart=/usr/bin/node server.js<br/>Restart=always<br/>"
               "[Install]<br/>WantedBy=multi-user.target", style_code))

    f.append(P("Troubleshooting", style_h2))
    f.append(table([
        ["Problem", "What to try"],
        ["<b>\"Could not reach the server\"</b>", "Switch on Tailscale (if the address is 100.x), check address and port, and that "
         "the server is running."],
        ["AppImage does nothing or complains about FUSE / sandbox", "See the install section: <b>libfuse2</b>, or <b>--appimage-extract-and-run</b>, "
         "or <b>--no-sandbox</b>."],
        ["No window after closing it", "It is hidden in the tray. Start Skippy again, or use the tray menu."],
        ["Black video from my camera", "Close other programs using the camera; check <b>v4l2-ctl --list-devices</b>; "
         "pick the camera under <b>Devices</b>."],
        ["Can't hear others", "Check the output device under <b>Devices</b> and in your sound settings (PipeWire/PulseAudio)."],
        ["Screen share is black or fails", "On Wayland make sure the desktop portal is installed; or try <b>--ozone-platform=x11</b>."],
        ["Forgot my password", "Use <b>Forgot password?</b> on the login screen with your recovery key."],
    ], [2.2, 5.0]))

    f.append(P("Reporting a problem", style_h2))
    f.append(P("Open an issue at <b>github.com/lrizio/Skippy/issues</b> and say:"))
    f.append(bullets([
        "Skippy <b>version</b> (shown as \"Skippy v...\" on the login and lobby screens) and which file you used (AppImage or deb, x86_64 or arm64).",
        "Your <b>distribution and version</b>, desktop (GNOME, KDE...) and whether it is <b>Wayland or X11</b> "
        "(<b>echo $XDG_SESSION_TYPE</b>).",
        "What you did, what you expected and what happened. If Skippy won't start, run it from a terminal and paste the "
        "messages it prints.",
        "Please <b>don't</b> include passwords, recovery keys or a private server address.",
    ]))
    f.append(P("Also useful: tell the author what <i>did</i> work, so it can be marked as verified.", g.style_body))
    f.append(Spacer(1, 4))
    f.append(P(f"Skippy for Linux shares its code with the Windows desktop app (v{VERSION}); the desktop User Guide covers "
               "accounts, rooms and the server in more detail. Source and releases: github.com/lrizio/Skippy.",
               ParagraphStyle("end", parent=g.style_body, textColor=MUTED, fontSize=9)))
    doc.build(f, onFirstPage=footer, onLaterPages=footer)
    print("wrote", OUT_PATH)


if __name__ == "__main__":
    build()
