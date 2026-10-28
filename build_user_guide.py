#!/usr/bin/env python3
"""Generates docs/Skippy User Guide.pdf -- the end-user guide (same look as the other HamProjects guides).

Screenshots come from docs/guide/, rendered by scripts/guide_screens.js.

Usage (from the project root):
    node scripts/guide_screens.js      # only when the screens have changed
    python build_user_guide.py

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
from reportlab.platypus import (CondPageBreak, Image, KeepTogether, ListFlowable, ListItem, PageBreak,
                                Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle)

APP = "Skippy"
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(ROOT, "docs", f"{APP} User Guide.pdf")
SHOTS = os.path.join(ROOT, "docs", "guide")
VERSION = json.load(open(os.path.join(ROOT, "app", "package.json"), encoding="utf-8"))["version"]

ACCENT = colors.HexColor("#1565c0")
CALLOUT_BG = colors.HexColor("#fff3e0")
CALLOUT_BORDER = colors.HexColor("#e0a030")
NOTE_BG = colors.HexColor("#e8f0fe")
NOTE_BORDER = colors.HexColor("#8ab4f8")
TABLE_HEADER_BG = colors.HexColor("#eeeeee")
MUTED = colors.HexColor("#555555")
CONTENT_W = 7.2 * inch
SHOT_W = 5.6 * inch  # most screenshots are 1280x800; a little narrower than the page keeps pages balanced

styles = getSampleStyleSheet()
style_title = ParagraphStyle("GuideTitle", parent=styles["Title"], fontSize=26, leading=30, spaceAfter=2)
style_subtitle = ParagraphStyle("GuideSubtitle", parent=styles["Normal"], fontSize=11, leading=14,
                                textColor=MUTED, alignment=TA_CENTER, spaceAfter=14)
style_body = ParagraphStyle("GuideBody", parent=styles["Normal"], fontSize=10, leading=13, spaceAfter=5)
style_h2 = ParagraphStyle("GuideH2", parent=styles["Heading2"], fontSize=12.5, leading=14, textColor=ACCENT,
                          spaceBefore=8, spaceAfter=3, keepWithNext=1)
style_bullet = ParagraphStyle("GuideBullet", parent=styles["Normal"], fontSize=9.5, leading=12)
style_note = ParagraphStyle("GuideNote", parent=styles["Normal"], fontSize=9.5, leading=13)
style_cell = ParagraphStyle("GuideCell", parent=styles["Normal"], fontSize=9, leading=11.5)
style_head = ParagraphStyle("GuideHead", parent=style_cell, fontName="Helvetica-Bold")
style_caption = ParagraphStyle("GuideCaption", parent=styles["Normal"], fontSize=8.5, leading=11,
                               textColor=MUTED, alignment=TA_CENTER, spaceBefore=2, spaceAfter=8)
style_code = ParagraphStyle("GuideCode", parent=styles["Code"], fontSize=8.5, leading=11,
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
    data = [[Paragraph(c, style_head) for c in rows[0]]] + \
           [[Paragraph(c, style_cell) for c in r] for r in rows[1:]]
    return Table(data, colWidths=[w * inch for w in widths], repeatRows=1,
                 style=TableStyle([("BACKGROUND", (0, 0), (-1, 0), TABLE_HEADER_BG),
                                   ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#bbbbbb")),
                                   ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                   ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))


def shot(name, width=SHOT_W, caption=None):
    path = os.path.join(SHOTS, name)
    w, h = PILImage.open(path).size
    parts = [Image(path, width=width, height=width * h / w, hAlign="CENTER")]
    if caption:
        parts.append(Paragraph(caption, style_caption))
    return KeepTogether(parts)


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(0.65 * inch, 0.3 * inch, f"{APP} User Guide  -  v{VERSION}")
    canvas.drawRightString(LETTER[0] - 0.65 * inch, 0.3 * inch, f"Page {doc.page}")
    canvas.restoreState()


def build():
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    doc = SimpleDocTemplate(OUT_PATH, pagesize=LETTER, title=f"{APP} User Guide", author="VK3EI",
                            topMargin=0.45 * inch, bottomMargin=0.55 * inch,
                            leftMargin=0.65 * inch, rightMargin=0.65 * inch)
    f = []
    f.append(P(f"{APP} User Guide", style_title))
    f.append(P(f"Group video calls for up to 10 people  -  version {VERSION}", style_subtitle))
    f.append(Table([[""]], colWidths=[CONTENT_W], rowHeights=[1],
                   style=TableStyle([("LINEBELOW", (0, 0), (-1, -1), 1, colors.HexColor("#cccccc"))])))
    f.append(Spacer(1, 8))
    f.append(P(
        "Skippy is a desktop video-conferencing program in the style of Skype. Up to <b>10 people</b> can share "
        "one call with audio and video, a text chat that keeps its history, and file transfer. You can also "
        "<b>call one specific person</b> at any time for a private two-person call. Everyone signs in with an "
        "account, and an optional authenticator-app code protects it."))
    f.append(shot("call.png", caption="A room with two people. Video tiles on the left, chat and file transfer on the right, "
                                      "controls and device pickers along the bottom."))

    # -------------------------------------------------------------------------
    f.append(P("How Skippy fits together", style_h2))
    f.append(P(
        "There are two parts. The <b>Skippy app</b> is what you install and run on your computer. The "
        "<b>Skippy server</b> is a small program that one person in your group runs. It keeps the accounts and "
        "the chat history, shows who is online, rings people and helps your computers find each other. "
        "<b>Audio, video and files go directly between the participants</b>, not through the server."))
    f.append(bullets([
        "<b>Joining an existing group:</b> install the app and enter the server address your host gives you "
        "(step 3 below). That is all.",
        "<b>Hosting a group:</b> also run the server on one computer that stays on while people are using Skippy.",
    ]))

    # -------------------------------------------------------------------------
    f.append(P("Installing", style_h2))
    f.append(numbered([
        "<b>The app (Windows).</b> Download <i>Skippy-Setup-&lt;version&gt;.exe</i> from the project's Releases page "
        "(github.com/lrizio/Skippy/releases) and run it. Windows SmartScreen may say <i>unknown publisher</i> "
        "because the installer is not code-signed: click <b>More info</b>, then <b>Run anyway</b>. The installer "
        "adds Start-menu and Desktop shortcuts.",
        "<b>The server (the host only).</b> Install Node.js 22.5 or newer from nodejs.org. Download "
        "<i>Skippy-Server-&lt;version&gt;.zip</i> from the same page, unzip it and open a command window in that folder:",
    ]))
    f.append(P("npm install<br/>node server.js", style_code))
    f.append(P("On Windows you can instead double-click <i>Start Skippy Server.bat</i> after the first "
               "<i>npm install</i>. The server listens on port <b>8470</b> and stores its data in <i>skippy.db</i> "
               "beside it. If Windows Firewall asks about Node.js, allow it on <b>private networks</b>."))
    f.append(P("<b>3. Tell the app where the server is.</b> On the login screen, expand <b>Server</b> and type the "
               "address, for example <i>ws://192.168.1.20:8470</i> (the host's computer on your network). The "
               "address is remembered. Everyone in a group must use the same server."))
    f.append(box("<b>Can everyone reach the server?</b> On one home network, yes. Across the internet the host "
                 "needs to forward port 8470 on the router, or the group can use a VPN such as Tailscale. For use "
                 "over the internet, put the server behind a TLS (https) front end and use an address starting "
                 "<i>wss://</i>, otherwise passwords travel unencrypted."))

    # -------------------------------------------------------------------------
    f.append(CondPageBreak(3.2 * inch))
    f.append(P("Creating an account and logging in", style_h2))
    f.append(P("The first time you run Skippy you must create an account. After that you just log in."))
    f.append(shot("register.png", width=4.4 * inch, caption="Create account: your name, email, an optional callsign and a password."))
    f.append(bullets([
        "<b>Name</b> is what other people see. It must be unique. <b>Email</b> is also unique. <b>Callsign</b> is "
        "optional (letters and digits, e.g. W1AW) and is shown beside your name. The password needs at least "
        "8 characters.",
        "To log in you can type your <b>name, email or callsign</b> - any one of them - and your password.",
        "Skippy <b>remembers the last login</b>: the next time you start the app it signs you straight in as "
        "the same person.",
        "To use a different account, press <b>Log out</b> (top right of the lobby). The login screen returns with "
        "the last name already filled in; type another name to log in as someone else.",
    ]))
    f.append(shot("login.png", width=4.4 * inch, caption="The login screen. Server, update-check and start-at-sign-in options are underneath."))

    # -------------------------------------------------------------------------
    f.append(CondPageBreak(3.2 * inch))
    f.append(P("The lobby: choosing your devices", style_h2))
    f.append(shot("lobby.png", width=5.2 * inch, caption="The lobby. Your camera preview and microphone level are on the left; joining a room is on the right."))
    f.append(bullets([
        "Pick your <b>Microphone</b>, <b>Camera</b> and <b>Speaker</b> from the three lists. The preview and the "
        "green level bar update at once so you can check them before anyone sees or hears you.",
        "Your choices are remembered. You can change them again during a call (see <i>In a call</i>).",
        "If Windows asks for permission to use the camera or microphone, allow it. If you have no camera "
        "you can still join with audio only.",
        "A camera or microphone plugged in later appears in the lists automatically.",
    ]))

    f.append(P("Joining a room", style_h2))
    f.append(P("Type a <b>room name</b> and press <b>Join</b>. Anyone who types the same name joins the same call, so "
               "agree a name with your group (for example <i>weeknight-net</i>). Names are not case sensitive. "
               "A room holds <b>10 people</b>; an eleventh person is told the room is full. Rooms you have used "
               "appear under <b>Recent rooms</b> for one-click joining."))

    # -------------------------------------------------------------------------
    f.append(CondPageBreak(4 * inch))
    f.append(P("In a call", style_h2))
    f.append(table([
        ["Control", "What it does"],
        ["<b>Mute / Unmute</b>", "Stops or restarts your microphone. Others see nothing change on your tile; they simply stop hearing you."],
        ["<b>Stop video / Start video</b>", "Turns your camera off or on. Others see your initial on a grey tile while it is off."],
        ["<b>Mic, Camera, Speaker</b> lists", "Switch devices without leaving the call."],
        ["<b>Leave</b>", "Leaves the call and returns to the lobby."],
        ["<b>Call someone</b>", "Opens the list of people online so you can ring one of them (see <i>Calling someone directly</i>)."],
        ["Header (e.g. <i>2 / 10</i>)", "How many people are in the room out of the maximum."],
    ], [2.0, 5.2]))
    f.append(Spacer(1, 6))
    f.append(P("Each person has a tile that shows the connection state while it is being set up. "
               "Skippy lowers the video quality automatically as more people join (each person's video goes to "
               "every other person), so a crowded call looks a little softer than a two-person one. If your "
               "internet connection drops, a <i>Reconnecting</i> notice appears and Skippy rejoins by itself."))

    # -------------------------------------------------------------------------
    f.append(P("Chat and history", style_h2))
    f.append(bullets([
        "Type in the box at the bottom right and press <b>Enter</b> or <b>Send</b>. Everyone in the room sees it at once.",
        "<b>Chat history is kept.</b> Messages are saved on the server per room. When you (or anyone) join "
        "again later, the most recent 200 messages appear above a divider, followed by a divider and anything new.",
        "Joins and leaves are shown as small grey notes.",
    ]))

    f.append(P("Sending files", style_h2))
    f.append(bullets([
        "Click the <b>paper-clip</b> button, choose a file and it is sent <b>straight to everyone in the call</b> "
        "(up to <b>2 GB</b>). A progress bar shows on the chat entry; it says <i>Sent to N participants</i> when done.",
        "People receiving it see <i>Receiving...</i> and then <b>Save</b>. Click Save and choose where to put "
        "the file. Received files are written to disk as they arrive, so large files do not use up memory.",
        "A file is only delivered to the people <b>in the room when it is sent</b>. The chat history remembers "
        "the file's name and size, but people who join later cannot download it - send it again if needed.",
    ]))
    f.append(warn("Very large files take as long as your internet upload allows (in a room of several people the "
                  "file is sent to each person). Closing the call or losing the connection during a transfer "
                  "cancels it; the receiver sees <i>Transfer interrupted</i>."))

    # -------------------------------------------------------------------------
    f.append(CondPageBreak(3.2 * inch))
    f.append(P("Calling someone directly", style_h2))
    f.append(P("You can call one particular person at any time - from the lobby or while you are in another call - "
               "as long as they are logged in to Skippy."))
    f.append(numbered([
        "Click <b>Call someone</b>. The list shows everyone who is online right now.",
        "Press <b>Call</b> beside a name, or type a <b>name or callsign</b> in the box and press Call.",
        "Your screen shows <i>Calling ...</i> with a <b>Cancel</b> button and plays a ring-back tone.",
    ]))
    f.append(shot("people.png", width=4.9 * inch, caption="The people-online list."))
    f.append(P("The other person's Skippy rings, shows who is calling and, if the window was hidden in the "
               "system tray, brings it to the front:"))
    f.append(shot("incoming.png", width=4.9 * inch, caption="The incoming-call dialog on the other person's screen."))
    f.append(bullets([
        "<b>Accept</b> opens a private call between the two of you (the header shows a phone icon and their name). "
        "If you were in another room, you leave it.",
        "<b>Decline</b> tells the caller. If nobody answers within <b>45 seconds</b> the caller is told they did not answer.",
        "Your private chat with that person has its own history, so the conversation continues next time you call.",
        "People who are logged out cannot be rung: the caller is told they are not online.",
    ]))

    # -------------------------------------------------------------------------
    f.append(P("Running in the background", style_h2))
    f.append(bullets([
        "Closing the Skippy window does <b>not</b> quit it. It hides in the <b>system tray</b> (the notification "
        "area at the bottom right of the taskbar) so it can still ring you. Click the tray icon to open it again.",
        "To really quit, right-click the tray icon and choose <b>Quit Skippy</b>.",
        "<b>Logging out</b> also sends Skippy to the tray. While you are logged out nobody can call you - open "
        "it from the tray and log in again when you want to be reachable.",
        "To have Skippy start (hidden) whenever you sign in to your computer, tick <b>Start Skippy when I sign in to "
        "this computer</b> on the login screen or in the tray menu.",
    ]))

    # -------------------------------------------------------------------------
    f.append(CondPageBreak(5 * inch))
    f.append(P("Two-factor authentication (optional)", style_h2))
    f.append(P("Two-factor authentication adds a second step when you log in: a 6-digit code from an authenticator "
               "app on your phone. It is optional and set per person."))
    f.append(P("<b>Turning it on</b>", style_body))
    f.append(numbered([
        "Install an authenticator app if you do not have one (Google Authenticator, Microsoft Authenticator, Authy, "
        "1Password and others all work).",
        "In the lobby click <b>Security</b>, then <b>Turn on</b>.",
        "Scan the QR code with the app (or type the key shown under it). The app starts showing a 6-digit code.",
        "Type the current code into Skippy and press <b>Turn on</b>.",
    ]))
    f.append(shot("security-setup.png", width=4.9 * inch, caption="Setup: scan the QR code, then enter the code the app shows."))
    f.append(P("<b>Save your backup codes.</b> Skippy then shows <b>10 one-time backup codes</b>. Copy them somewhere "
               "safe. Each works once if you lose your phone, and they are <b>not shown again</b>."))
    f.append(shot("security-codes.png", width=4.9 * inch, caption="The backup codes, shown once."))
    f.append(P("<b>Logging in afterwards.</b> Enter your name and password as usual; Skippy then asks for the "
               "authentication code (or a backup code). Starting the app and being signed in automatically does not "
               "ask again - the code is needed when you log in fresh, for example after logging out or on a new computer. "
               "To turn it off, open <b>Security</b> and enter your password and a current code."))
    f.append(warn("<b>Lost your phone and your backup codes?</b> Ask the person who runs your server. They can switch "
                  "two-factor off for your account by running <i>node reset-totp.js your-name</i> in the server folder, "
                  "after which you can set it up again."))

    # -------------------------------------------------------------------------
    f.append(P("Updates and version", style_h2))
    f.append(P("The version number is in the window's title bar and at the bottom of the login and lobby screens. "
               "When Skippy starts it checks whether a newer version has been published, either by your server or on "
               "the project's GitHub Releases page. If there is one, a banner appears with a <b>Download</b> button. "
               "To switch the check off, untick <b>Check for updates on startup</b> on the login screen. Nothing is "
               "downloaded or installed automatically."))

    # -------------------------------------------------------------------------
    f.append(CondPageBreak(3 * inch))
    f.append(P("Limits and good to know", style_h2))
    f.append(table([
        ["Item", "Limit / behaviour"],
        ["People per room", "10. An eleventh person is told the room is full."],
        ["File size", "2 GB per file."],
        ["Chat", "Up to 4000 characters per message; the last 200 messages are shown when you join."],
        ["Calling", "Only people who are logged in. Rings for 45 seconds."],
        ["Same account twice", "Joining a room from a second window with the same account moves you there and drops the first."],
        ["Account recovery", "There is no self-service password reset. Ask the server's host if you forget your password."],
        ["Privacy", "Audio, video and files are encrypted between participants. The server holds accounts, chat text and file names - not your media or file contents."],
    ], [1.7, 5.5]))

    f.append(P("Troubleshooting", style_h2))
    f.append(table([
        ["Symptom", "What to check"],
        ["\"Could not reach the server\"", "Is the server running? Is the address in <b>Server</b> right (<i>ws://host:8470</i>)? "
                                            "On the same network, check the host's Windows Firewall allows Node.js. Across the internet, is "
                                            "port 8470 forwarded, or are you both on the same VPN?"],
        ["Everyone shows \"connecting\" but never connects", "Strict routers or firewalls can block direct connections. Try a VPN such as Tailscale, "
                                                             "or ask the host about adding a TURN relay (see the project README)."],
        ["Others cannot hear me", "Is the button showing <b>Unmute</b> (you are muted)? Is the right microphone chosen? "
                                  "The level bar in the lobby should move when you speak."],
        ["No camera picture", "Is another program using the camera? Choose it again from the Camera list, or check "
                              "Windows <i>Privacy &amp; security &gt; Camera</i> allows desktop apps."],
        ["I cannot hear anyone", "Check the Speaker list and your computer's volume. If you switched speakers, pick it again."],
        ["Video is blurry with many people", "Normal: quality is lowered automatically as the room fills."],
        ["\"Room is full\"", "The room already has 10 people."],
        ["\"Invalid login or password\"", "Check the name/email/callsign and password. After many wrong tries in a minute "
                                         "you are asked to wait."],
        ["Cannot call someone", "They must be logged in (shown in the list). If they are logged out or quit the app, "
                                "you will be told they are not online."],
        ["Reconnecting banner keeps appearing", "Your connection to the server is unstable, or the server was restarted. "
                                                 "Skippy will rejoin when it can."],
        ["Windows says \"unknown publisher\" at install", "The installer is not code-signed. Choose <b>More info</b> then <b>Run anyway</b>."],
    ], [2.2, 5.0]))
    doc.build(f, onFirstPage=footer, onLaterPages=footer)
    print("wrote", OUT_PATH)


if __name__ == "__main__":
    build()
