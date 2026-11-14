#!/usr/bin/env python3
"""Generates docs/Skippy for Mac and iPhone User Guide.pdf -- install + use guide for the Apple builds.

Screenshots are reused from docs/guide (desktop) and docs/guide-android (phone): the Mac and iPhone apps run the
same interface, so the layouts match. Usage (from the project root):  python build_apple_guide.py
Requires: pip install reportlab pillow (build-time only).
"""
from __future__ import annotations

import json
import os

from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (Image, KeepTogether, ListFlowable, ListItem, PageBreak, Paragraph,
                                SimpleDocTemplate, Spacer, Table, TableStyle)

APP = "Skippy for Mac and iPhone"
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(ROOT, "docs", f"{APP} User Guide.pdf")
DESK = os.path.join(ROOT, "docs", "guide")
PHONE = os.path.join(ROOT, "docs", "guide-android")
VERSION = json.load(open(os.path.join(ROOT, "app", "package.json"), encoding="utf-8"))["version"]
TAG = f"apple-v{VERSION}"

ACCENT = colors.HexColor("#1565c0")
CALLOUT_BG, CALLOUT_BORDER = colors.HexColor("#fff3e0"), colors.HexColor("#e0a030")
NOTE_BG, NOTE_BORDER = colors.HexColor("#e8f0fe"), colors.HexColor("#8ab4f8")
TABLE_HEADER_BG = colors.HexColor("#eeeeee")
MUTED = colors.HexColor("#555555")
CONTENT_W = 7.2 * inch

styles = getSampleStyleSheet()
style_title = ParagraphStyle("T", parent=styles["Title"], fontSize=26, leading=30, spaceAfter=2)
style_subtitle = ParagraphStyle("S", parent=styles["Normal"], fontSize=11, leading=14, textColor=MUTED,
                                alignment=TA_CENTER, spaceAfter=14)
style_body = ParagraphStyle("B", parent=styles["Normal"], fontSize=10, leading=13, spaceAfter=5)
style_h1 = ParagraphStyle("H1", parent=styles["Heading1"], fontSize=17, leading=20, textColor=ACCENT,
                          spaceBefore=4, spaceAfter=6, keepWithNext=1)
style_h2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=12.5, leading=14, textColor=ACCENT,
                          spaceBefore=10, spaceAfter=3, keepWithNext=1)
style_h3 = ParagraphStyle("H3", parent=styles["Heading3"], fontSize=10.5, leading=13, spaceBefore=6, spaceAfter=2,
                          keepWithNext=1)
style_bullet = ParagraphStyle("BL", parent=styles["Normal"], fontSize=9.5, leading=12)
style_note = ParagraphStyle("N", parent=styles["Normal"], fontSize=9.5, leading=13)
style_cell = ParagraphStyle("C", parent=styles["Normal"], fontSize=9, leading=11.5)
style_head = ParagraphStyle("CH", parent=style_cell, fontName="Helvetica-Bold")
style_caption = ParagraphStyle("CAP", parent=styles["Normal"], fontSize=8.5, leading=11, textColor=MUTED,
                               alignment=TA_CENTER, spaceBefore=2, spaceAfter=6)
style_code = ParagraphStyle("CODE", parent=styles["Code"], fontSize=8.5, leading=11,
                            backColor=colors.HexColor("#f4f4f4"), borderPadding=6, spaceBefore=4, spaceAfter=8)


def P(text, style=style_body):
    return Paragraph(text, style)


def bullets(items):
    return ListFlowable([ListItem(Paragraph(i, style_bullet), spaceAfter=2.5) for i in items],
                        bulletType="bullet", bulletFontSize=7, leftIndent=14, bulletOffsetY=1)


def numbered(items):
    return ListFlowable([ListItem(Paragraph(i, style_bullet), spaceAfter=4) for i in items],
                        bulletType="1", leftIndent=18)


def box(text, bg=NOTE_BG, border=NOTE_BORDER):
    return Table([[Paragraph(text, style_note)]], colWidths=[CONTENT_W],
                 style=TableStyle([("BACKGROUND", (0, 0), (-1, -1), bg), ("BOX", (0, 0), (-1, -1), 1, border),
                                   ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                                   ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))


def warn(text):
    return box(text, CALLOUT_BG, CALLOUT_BORDER)


def table(rows, widths):
    data = [[Paragraph(c, style_head) for c in rows[0]]] + [[Paragraph(c, style_cell) for c in r] for r in rows[1:]]
    return Table(data, colWidths=[w * inch for w in widths], repeatRows=1,
                 style=TableStyle([("BACKGROUND", (0, 0), (-1, 0), TABLE_HEADER_BG),
                                   ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#bbbbbb")),
                                   ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                   ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))


def shots(folder, items, width):
    cells = []
    for name, cap in items:
        path = os.path.join(folder, name)
        w, h = PILImage.open(path).size
        cells.append([Image(path, width=width, height=width * h / w, hAlign="CENTER"), Paragraph(cap, style_caption)])
    t = Table([[c[0] for c in cells], [c[1] for c in cells]], colWidths=[CONTENT_W / len(cells)] * len(cells))
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("ALIGN", (0, 0), (-1, -1), "CENTER")]))
    return KeepTogether([t])


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(0.65 * inch, 0.3 * inch, f"{APP} User Guide  -  version {VERSION} (test release)")
    canvas.drawRightString(LETTER[0] - 0.65 * inch, 0.3 * inch, f"Page {doc.page}")
    canvas.restoreState()


def build():
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    doc = SimpleDocTemplate(OUT_PATH, pagesize=LETTER, title=f"{APP} User Guide", author="VK3EI",
                            topMargin=0.45 * inch, bottomMargin=0.55 * inch,
                            leftMargin=0.65 * inch, rightMargin=0.65 * inch)
    f = []
    f.append(P(f"{APP} User Guide", style_title))
    f.append(P(f"Install and use Skippy on a Mac and on an iPhone  -  version {VERSION}", style_subtitle))
    f.append(Table([[""]], colWidths=[CONTENT_W], rowHeights=[1],
                   style=TableStyle([("LINEBELOW", (0, 0), (-1, -1), 1, colors.HexColor("#cccccc"))])))
    f.append(Spacer(1, 8))
    f.append(P(
        "Skippy is group video calling for up to 10 people: audio, video, chat, file transfer and direct calls. "
        "This guide covers the <b>Mac app</b> and the <b>iPhone app</b>. Both connect to a Skippy server run by "
        "someone in your group, so you need that server's address and an account on it."))
    f.append(warn(
        "<b>These are test releases.</b> The Mac and iPhone apps were built and checked for errors, but the author "
        "does not own Apple devices and has not been able to run them. You are among the first people to try them. "
        "If something doesn't work, please report it - see <b>Reporting a problem</b> at the end. Thank you!"))

    # ============================================================ MAC
    f.append(P("Part 1 - The Mac app", style_h1))
    f.append(P("What you need", style_h2))
    f.append(bullets([
        "A Mac running <b>macOS 12 (Monterey) or newer</b> (a recent version is best), Apple silicon or Intel. One file works on both.",
        "The <b>server address</b> from whoever runs your Skippy server, for example <b>100.64.0.10:8470</b>.",
        "If that address starts with <b>100.</b> it is a Tailscale address: install <b>Tailscale</b> on the Mac, "
        "sign in to the same account as the server and switch it on.",
        f"The file <b>Skippy-{VERSION}-mac.dmg</b> from the <b>{TAG}</b> release at github.com/lrizio/Skippy/releases "
        "(about 220 MB).",
    ]))
    f.append(P("Install", style_h2))
    f.append(numbered([
        f"Download <b>Skippy-{VERSION}-mac.dmg</b> and double-click it in your Downloads folder.",
        "Drag the <b>Skippy</b> icon onto the <b>Applications</b> folder in the window that opens. Eject the disk image.",
        "Open <b>Applications</b>, <b>right-click</b> (or Control-click) <b>Skippy</b> and choose <b>Open</b>. "
        "A warning appears; click <b>Open</b> again. You only do this the first time.",
    ]))
    f.append(warn(
        "<b>\"Skippy can't be opened because Apple cannot check it for malicious software.\"</b> The app is not "
        "signed with an Apple developer certificate (that costs the author US$99 a year), so macOS is cautious. "
        "If right-click Open does not offer an Open button: open <b>System Settings, Privacy &amp; Security</b>, "
        "scroll down to the message about Skippy and click <b>Open Anyway</b>. Or, in Terminal, run:"))
    f.append(P("xattr -dr com.apple.quarantine /Applications/Skippy.app", style_code))
    f.append(P("Only do this with the file from the official release page."))

    f.append(P("First start", style_h2))
    f.append(numbered([
        "macOS asks to let Skippy use the <b>microphone</b> and then the <b>camera</b>. Click <b>OK</b> to both. "
        "(If you said no: <b>System Settings, Privacy &amp; Security, Camera / Microphone</b>, switch Skippy on, "
        "then quit and reopen Skippy.)",
        "On the login screen open <b>Server</b> and type the server address (the <b>ws://</b> at the front is optional).",
        "New here? Click <b>Create account</b>. Otherwise log in with your name, email or callsign. "
        "Save the <b>recovery key</b> Skippy shows you - it is the only way back in if you forget your password.",
    ]))
    f.append(shots(DESK, [("login.png", "Login screen (shown on Windows; the Mac looks the same inside the window)."),
                          ("lobby.png", "The lobby: preview, devices, rooms and who is online.")], 3.3 * inch))

    f.append(P("Using the Mac app", style_h2))
    f.append(P(
        "Everything works as in the Windows desktop app: rooms, direct calls, chat, file transfer, two-step codes, "
        "and the people list. Differences on the Mac:"))
    f.append(table([
        ["Topic", "On the Mac"],
        ["Menu bar icon", "Skippy puts an icon in the <b>menu bar</b> (top right). Click it for <b>Open Skippy</b>, "
         "<b>Start when I sign in to this computer</b> and <b>Quit Skippy</b>."],
        ["Closing the window", "The red close button <b>hides</b> the window; Skippy keeps running so calls can still "
         "come in, and the Dock icon disappears. Click the menu bar icon to bring it back. To really quit: "
         "<b>Cmd+Q</b> or menu bar icon, <b>Quit Skippy</b>."],
        ["Start at login", "Tick <b>Start when I sign in to this computer</b> in the menu bar menu. Skippy then starts hidden."],
        ["Screen sharing", "Click <b>Share</b> and pick a screen or window. The first time, macOS asks for "
         "<b>Screen Recording</b> permission: <b>System Settings, Privacy &amp; Security, Screen &amp; System Audio "
         "Recording</b>, switch Skippy on, then quit and reopen Skippy."],
        ["Tailscale warning", "If the server is on Tailscale and it is switched off, Skippy shows a banner with a button to turn it on."],
        ["Updates", "Skippy tells you when a newer release exists; download the new .dmg and drag it over the old app."],
    ], [1.6, 5.6]))
    f.append(P("Recording and transcripts on the Mac", style_h3))
    f.append(P(
        "<b>Record</b> saves one audio track per speaker to <b>Documents/Skippy Recordings</b>. To turn recordings into "
        "a text transcript the Mac needs a free speech engine. In Terminal (with <a href='https://brew.sh' "
        "color='#1565c0'>Homebrew</a> installed) run:"))
    f.append(P("brew install whisper-cpp", style_code))
    f.append(P("Then in Skippy open <b>Recordings</b> and choose the transcript setup: it downloads the language "
               "model (about 190 MB) once. After that transcripts are made on your Mac, offline."))

    # ============================================================ IPHONE
    f.append(PageBreak())
    f.append(P("Part 2 - The iPhone app", style_h1))
    f.append(P(
        "The iPhone app is a <b>client only</b>, like the Android one: log in, join rooms, call one person, chat and "
        "send files. Not on the phone: screen sharing, recording/transcripts, and <b>ringing while the app is closed</b> "
        "- people can call you only while Skippy is open."))
    f.append(P("What you need", style_h2))
    f.append(bullets([
        "An iPhone (or iPad) running <b>iOS 15 or newer</b>.",
        "The <b>server address</b> (see above) and, for a 100.x address, the <b>Tailscale</b> app switched on.",
        f"The file <b>Skippy-unsigned.ipa</b> from the <b>{TAG}</b> release, and a way to sign it (below).",
    ]))
    f.append(warn(
        "<b>Why installing is more work than on Android.</b> Apple only lets apps onto an iPhone if they are signed. "
        "Skippy is not on the App Store, so you sign it yourself with your own (free) Apple ID, using one of the tools "
        "below. A free Apple ID's apps stop opening after <b>7 days</b> and must be signed again (the tools can do "
        "this automatically while the phone and computer are on the same Wi-Fi). A paid Apple Developer account "
        "(US$99 a year) lasts a year."))
    f.append(P("Install - choose one method", style_h2))
    f.append(P("Method A: Sideloadly (Mac or Windows PC, simplest)", style_h3))
    f.append(numbered([
        "Install <b>Sideloadly</b> (sideloadly.io) on your computer. On Windows it also needs iTunes and iCloud from "
        "apple.com (not the Microsoft Store versions) - Sideloadly tells you.",
        "Connect the iPhone with a cable and tap <b>Trust This Computer</b>.",
        "Drag <b>Skippy-unsigned.ipa</b> into Sideloadly, type your <b>Apple ID</b>, and click <b>Start</b>. "
        "Enter your Apple ID password when asked (it goes to Apple, not to Sideloadly's author or to Skippy).",
        "On the iPhone open <b>Settings, Privacy &amp; Security</b>, scroll down, switch on <b>Developer Mode</b> and "
        "restart when asked (iOS 16 and newer).",
        "Open <b>Settings, General, VPN &amp; Device Management</b>, tap your Apple ID under <i>Developer App</i> and "
        "tap <b>Trust</b>.",
        "Open <b>Skippy</b> from the Home Screen.",
    ]))
    f.append(P("Method B: AltStore", style_h3))
    f.append(P("Install <b>AltStore</b> (altstore.io) and its helper on your computer, install it on the iPhone, then in "
               "the AltStore app on the phone open <b>My Apps, +</b> and pick the .ipa (copy it to the phone first, for "
               "example with AirDrop or the Files app). AltStore refreshes the app by itself while it is on the same "
               "Wi-Fi as your computer. Steps 4 and 5 above apply too."))
    f.append(P("Method C: Xcode (Mac only, for developers)", style_h3))
    f.append(P("Download the source from github.com/lrizio/Skippy, run <b>cd android &amp;&amp; npm install &amp;&amp; "
               "npm run build:ios</b>, open <b>android/ios/App/App.xcodeproj</b> in Xcode, choose your team under "
               "<b>Signing &amp; Capabilities</b>, plug in the phone and press Run."))

    f.append(P("First start", style_h2))
    f.append(numbered([
        "Open <b>Skippy</b>. On the login screen open <b>Server</b> and enter the server address.",
        "Create an account or log in; save the <b>recovery key</b>.",
        "iOS asks for <b>camera</b>, <b>microphone</b> and, possibly, <b>local network</b> access. Allow them all. "
        "(Later changes: <b>Settings, Skippy</b>.)",
    ]))
    f.append(shots(PHONE, [("2-login-server.png", "Enter the server address under <b>Server</b>."),
                           ("3-lobby.png", "The lobby."),
                           ("4-call.png", "In a call.")], 2.0 * inch))
    f.append(P("<i>Screens above were captured from the Android build; the iPhone app shows the same layout.</i>",
               style_caption))
    f.append(P("Using the iPhone app", style_h2))
    f.append(table([
        ["To do this", "Do this"],
        ["Join or start a room", "Type a room name in the lobby and tap <b>Join</b>, or tap a room in the lists."],
        ["Call one person", "<b>Call someone</b> (lobby) or <b>Add someone</b> (in a call)."],
        ["Mute / camera off / flip camera", "<b>Mute</b>, <b>Stop video</b> and <b>Devices</b> at the top of the call screen."],
        ["Chat and files", "<b>Show chat</b> opens it over the call; the paperclip sends a file to everyone in the call."],
        ["Save a received file", "Tap <b>Save</b>. Open the <b>Files</b> app, <b>On My iPhone, Skippy</b>."],
        ["Sound output", "iOS chooses it: the Control Center audio button switches between speaker, earpiece and Bluetooth."],
    ], [2.0, 5.2]))
    f.append(Spacer(1, 6))
    f.append(box(
        "<b>Keep Skippy open during a call.</b> The screen stays awake in a call, and the audio keeps going if you "
        "lock the phone, but people can only call <b>you</b> while Skippy is open on the screen."))

    # ============================================================ TROUBLESHOOTING
    f.append(P("Troubleshooting", style_h2))
    f.append(table([
        ["Problem", "What to try"],
        ["<b>\"Could not reach the server\"</b>", "Switch on <b>Tailscale</b> (if the address is 100.x), check the address "
         "and port, and that the server program is running on its computer."],
        ["Mac: app won't open", "Right-click, <b>Open</b>; or <b>Privacy &amp; Security, Open Anyway</b>; or the "
         "<b>xattr</b> command in Part 1."],
        ["Mac: no camera or microphone", "<b>System Settings, Privacy &amp; Security, Camera / Microphone</b>: switch "
         "Skippy on, then quit it completely (Cmd+Q) and reopen."],
        ["Mac: window gone", "It is hidden, not closed: click the <b>menu bar icon</b>, <b>Open Skippy</b>."],
        ["iPhone: app opens then closes, or says \"Untrusted Developer\"", "Trust your Apple ID in <b>Settings, General, "
         "VPN &amp; Device Management</b>; turn on <b>Developer Mode</b>; if 7 days have passed, sign it again with Sideloadly/AltStore."],
        ["iPhone: no video or sound", "<b>Settings, Skippy</b>: allow Camera and Microphone. Check <b>Mute</b> and "
         "<b>Stop video</b>, the silent switch and the volume."],
        ["Forgot my password", "Use <b>Forgot password?</b> on the login screen with your recovery key."],
    ], [2.1, 5.1]))

    # ============================================================ REPORTING
    f.append(P("Reporting a problem", style_h2))
    f.append(P(
        "Because the author can't test on Apple hardware, your report is how these apps get fixed. Open an issue at "
        "<b>github.com/lrizio/Skippy/issues</b> (or send the author a message) and say:"))
    f.append(bullets([
        "<b>Which app</b> (Mac or iPhone) and the <b>version</b> (shown as &quot;Skippy v...&quot; on the login and lobby screens).",
        "Your <b>macOS / iOS version</b> and the Mac model or iPhone model.",
        "<b>What you did</b>, what you expected and what happened (a screenshot helps). For a call problem, say "
        "whether the other person was on Windows, Android, Mac or iPhone.",
        "Please <b>don't</b> include passwords, recovery keys or the server's address if it's private.",
    ]))
    f.append(P("Also useful: tell the author what <i>did</i> work, so it can be marked as verified.", style_body))
    f.append(Spacer(1, 4))
    f.append(P(f"Skippy for Mac and iPhone share their code with the Windows desktop app (v{VERSION}); the desktop User "
               "Guide covers accounts, rooms and running the server in more detail. Source and releases: "
               "github.com/lrizio/Skippy.", ParagraphStyle("end", parent=style_body, textColor=MUTED, fontSize=9)))

    doc.build(f, onFirstPage=footer, onLaterPages=footer)
    print("wrote", OUT_PATH)


if __name__ == "__main__":
    build()
