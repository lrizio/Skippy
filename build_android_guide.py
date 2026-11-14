#!/usr/bin/env python3
"""Generates docs/Skippy for Android User Guide.pdf -- install + use guide for the Android client.

Screenshots come from docs/guide-android/, rendered by scripts/android_guide_screens.js.

Usage (from the project root):
    node android/scripts/sync-web.js && node scripts/android_guide_screens.js   # only when the screens changed
    python build_android_guide.py

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

APP = "Skippy for Android"
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(ROOT, "docs", f"{APP} User Guide.pdf")
SHOTS = os.path.join(ROOT, "docs", "guide-android")
DESKTOP_VERSION = json.load(open(os.path.join(ROOT, "app", "package.json"), encoding="utf-8"))["version"]
APK_VERSION = DESKTOP_VERSION

ACCENT = colors.HexColor("#1565c0")
CALLOUT_BG = colors.HexColor("#fff3e0")
CALLOUT_BORDER = colors.HexColor("#e0a030")
NOTE_BG = colors.HexColor("#e8f0fe")
NOTE_BORDER = colors.HexColor("#8ab4f8")
TABLE_HEADER_BG = colors.HexColor("#eeeeee")
MUTED = colors.HexColor("#555555")
CONTENT_W = 7.2 * inch

styles = getSampleStyleSheet()
style_title = ParagraphStyle("T", parent=styles["Title"], fontSize=26, leading=30, spaceAfter=2)
style_subtitle = ParagraphStyle("S", parent=styles["Normal"], fontSize=11, leading=14, textColor=MUTED,
                                alignment=TA_CENTER, spaceAfter=14)
style_body = ParagraphStyle("B", parent=styles["Normal"], fontSize=10, leading=13, spaceAfter=5)
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


def shots(items, width=2.15 * inch):
    """A row of phone screenshots, each with a caption underneath."""
    cells = []
    for name, cap in items:
        path = os.path.join(SHOTS, name)
        w, h = PILImage.open(path).size
        cells.append([Image(path, width=width, height=width * h / w, hAlign="CENTER"), Paragraph(cap, style_caption)])
    t = Table([[c[0] for c in cells], [c[1] for c in cells]], colWidths=[CONTENT_W / len(cells)] * len(cells))
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("ALIGN", (0, 0), (-1, -1), "CENTER")]))
    return KeepTogether([t])


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(0.65 * inch, 0.3 * inch, f"{APP} User Guide  -  app v{APK_VERSION}")
    canvas.drawRightString(LETTER[0] - 0.65 * inch, 0.3 * inch, f"Page {doc.page}")
    canvas.restoreState()


def build():
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    doc = SimpleDocTemplate(OUT_PATH, pagesize=LETTER, title=f"{APP} User Guide", author="VK3EI",
                            topMargin=0.45 * inch, bottomMargin=0.55 * inch,
                            leftMargin=0.65 * inch, rightMargin=0.65 * inch)
    f = []
    f.append(P(f"{APP} User Guide", style_title))
    f.append(P(f"Install and use the Skippy phone app  -  app version {APK_VERSION}", style_subtitle))
    f.append(Table([[""]], colWidths=[CONTENT_W], rowHeights=[1],
                   style=TableStyle([("LINEBELOW", (0, 0), (-1, -1), 1, colors.HexColor("#cccccc"))])))
    f.append(Spacer(1, 8))
    f.append(P(
        "Skippy for Android puts the Skippy group video calls on your phone: log in, join rooms of up to 10 people, "
        "call one person directly, chat and send files. It is a <b>client only</b> - it connects to the same "
        "Skippy server your desktop app uses, so you need that server's address and an account on it."))

    f.append(P("What you need", style_h2))
    f.append(bullets([
        "An Android phone, <b>Android 7.0 or newer</b>, with a camera and microphone.",
        "The <b>server address</b> from whoever runs your Skippy server, for example <b>100.64.0.10:8470</b>.",
        "If that address starts with <b>100.</b> it is a Tailscale address: install the <b>Tailscale</b> app on the "
        "phone, sign in to the same account as the server and switch it on. Without it the phone cannot reach the server.",
        f"The file <b>Skippy-Android-{APK_VERSION}.apk</b> from the "
        "<b>latest release</b> at github.com/lrizio/Skippy/releases (the one release page holds the files for every platform).",
    ]))
    f.append(Spacer(1, 4))
    f.append(warn(
        "<b>Not from the Play Store.</b> This app is installed by hand (\"sideloading\"). Android will warn you about "
        "installing from outside the store - that is normal. Only install the file from the official release page."))

    # ------------------------------------------------------------------ install
    f.append(P("Install - choose one method", style_h2))
    f.append(P("Method A: install on the phone itself (easiest)", style_h3))
    f.append(numbered([
        "On the phone, open the browser and go to <b>github.com/lrizio/Skippy/releases</b>. Open the <b>latest "
        f"release</b> and tap <b>Skippy-Android-{APK_VERSION}.apk</b> in its list of files to download it.",
        "When the download finishes tap <b>Open</b> (or find it in the <b>Files</b> or <b>Downloads</b> app and tap it).",
        "Android says it can't install apps from this source: tap <b>Settings</b> and switch on "
        "<b>Allow from this source</b> for the browser or Files app you used, then press Back.",
        "Tap <b>Install</b>. If Google Play Protect says it hasn't seen the app before, tap <b>More details</b>, then "
        "<b>Install anyway</b>.",
        "Tap <b>Open</b>. Skippy is now in your app list too.",
    ]))
    f.append(P("Method B: install from a Windows PC over USB with adb", style_h3))
    f.append(P("Useful if you also do development, and the best way to update later (one command)."))
    f.append(numbered([
        "On the phone open <b>Settings, About phone</b> and tap <b>Build number</b> seven times to unlock Developer "
        "options. Then open <b>Settings, System, Developer options</b> and switch on <b>USB debugging</b>.",
        "Connect the phone to the PC with a USB cable. Unlock the phone and tap <b>Allow</b> on the "
        "\"Allow USB debugging?\" prompt (tick <i>Always allow</i>).",
        "On the PC, with the Android <b>platform-tools</b> installed, open a command prompt in the folder with the APK and run:",
    ]))
    f.append(P(f"adb devices<br/>adb install -r Skippy-Android-{APK_VERSION}.apk", style_code))
    f.append(P("<b>adb devices</b> must list your phone as <i>device</i>; <b>Success</b> means it installed. "
               "<b>-r</b> keeps your login and settings when you update."))
    f.append(P("Method C: copy the file over USB", style_h3))
    f.append(P(
        "Download the APK on the PC, connect the phone with a cable, choose <b>File transfer</b> in the USB notification, "
        "copy the APK to the phone's <b>Download</b> folder, then open it from the <b>Files</b> app and continue "
        "from step 3 of Method A."))

    # ------------------------------------------------------------------ first start
    f.append(PageBreak())
    f.append(P("First start", style_h2))
    f.append(numbered([
        "Open <b>Skippy</b>. On the login screen open <b>Server</b> and type the server address (the <b>ws://</b> "
        "at the front is optional).",
        "New here? Tap <b>Create account</b>, fill in name, email, optional callsign and a password of 8 or more "
        "characters. Existing account: log in with your name, email or callsign.",
        "Skippy shows a <b>recovery key</b> once - save it somewhere safe. It is the only way back in if you forget your password.",
        "When Android asks to let Skippy use the <b>camera</b> and <b>microphone</b>, allow both (while using the app is enough).",
    ]))
    f.append(shots([
        ("2-login-server.png", "Enter the server address under <b>Server</b>."),
        ("3-lobby.png", "The lobby: preview, devices, room name and who is online."),
    ], width=2.3 * inch))
    f.append(P(
        "If you turned on a two-step code (authenticator app) on the desktop, the phone asks for it after your "
        "password. To set it up from the phone, open <b>Security</b> in the lobby: instead of a QR code it shows the "
        "secret and an <b>Open in my authenticator app</b> link."))

    # ------------------------------------------------------------------ using
    f.append(P("Using Skippy on the phone", style_h2))
    f.append(table([
        ["To do this", "Do this"],
        ["Join or start a room", "Type a room name in the lobby and tap <b>Join</b>, or tap a room in the open or recent lists."],
        ["Call one person", "Tap <b>Call someone</b> (lobby) or <b>Add someone</b> (in a call) and pick them from the list."],
        ["Mute / camera off", "<b>Mute</b> and <b>Stop video</b> at the top of the call screen."],
        ["Pick or switch camera and microphone", "<b>Devices</b> in the call (or the lists in the lobby): choose the front or back camera."],
        ["Fill the screen with one person", "Double-tap their tile, or tap the corner button on it."],
        ["Chat", "<b>Show chat</b> opens the chat over the call; <b>Hide chat</b> brings the video back."],
        ["Send a file", "In the chat tap the paperclip and choose a file. Everyone in the call at that moment receives it."],
        ["Save a received file", "Tap <b>Save</b> next to the file; it goes to <b>Documents/Skippy</b> on the phone."],
        ["Leave", "Tap <b>Leave</b>."],
    ], [1.9, 5.3]))
    f.append(Spacer(1, 6))
    f.append(shots([
        ("4-call.png", "In a call: video tiles fill the screen, controls on top."),
        ("5-chat.png", "Chat opens over the call."),
    ], width=2.3 * inch))
    f.append(box(
        "<b>Keep Skippy open on the screen during a call.</b> The screen stays awake while you are in a call. "
        "The phone version has no background mode, and it <b>does not ring when the app is closed</b> - people can "
        "call you only while Skippy is open."))

    f.append(P("Different from the desktop app", style_h2))
    f.append(bullets([
        "No <b>screen sharing</b> and no <b>call recording / transcripts</b> on the phone.",
        "No window arranging: video tiles are laid out automatically.",
        "No Tailscale warning banner - the phone can't check Tailscale for you, so turn it on yourself.",
    ]))

    # ------------------------------------------------------------------ updating
    f.append(P("Updating", style_h2))
    f.append(P(
        "Download the newer APK and install it over the old one (Method A, or <b>adb install -r</b>); your login and "
        "settings are kept. If Android says <b>App not installed</b> or a conflict, the new file was signed with a "
        "different key: uninstall Skippy first (you will need to log in again) and install the new one."))

    f.append(P("Troubleshooting", style_h2))
    f.append(table([
        ["Problem", "What to try"],
        ["<b>\"Could not reach the server\"</b>",
         "Turn on <b>Tailscale</b> on the phone and make sure it shows connected. Check the address and port "
         "(for example 100.64.0.10:8470) and that the server program is running on its PC."],
        ["No video or sound from me",
         "Settings, Apps, Skippy, Permissions: allow <b>Camera</b> and <b>Microphone</b>. Also check <b>Mute</b> and "
         "<b>Stop video</b> aren't on."],
        ["I can't hear others", "Raise the media volume; check the phone isn't on silent or routed to a Bluetooth device."],
        ["Install blocked", "Allow <b>Install unknown apps</b> for the browser or Files app you opened the APK from "
         "(Method A, step 3). If Play Protect blocks it, choose <b>Install anyway</b>."],
        ["A received file can't be saved", "Tap <b>Save</b> again; files go to <b>Documents/Skippy</b> (or the app's own "
         "storage folder if Android refuses). Very large files are best received on the desktop app."],
        ["Forgot my password", "Use <b>Forgot password?</b> on the login screen with your recovery key."],
    ], [1.9, 5.3]))
    f.append(Spacer(1, 6))
    f.append(P(f"Skippy for Android shares its code with the desktop app (v{DESKTOP_VERSION}); the desktop User Guide "
               "covers accounts, rooms and the server in more detail. Source and releases: github.com/lrizio/Skippy.",
               ParagraphStyle("end", parent=style_body, textColor=MUTED, fontSize=9)))

    doc.build(f, onFirstPage=footer, onLaterPages=footer)
    print("wrote", OUT_PATH)


if __name__ == "__main__":
    build()
