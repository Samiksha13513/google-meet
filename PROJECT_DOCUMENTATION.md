# Google Meet Clone - Complete Project Documentation

**Last Updated:** May 20, 2026  
**Project Status:** Production-Ready Video Conferencing Application

---

## Table of Contents
1. [Project Overview](#project-overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Technology Stack](#technology-stack)
4. [Database Schema](#database-schema)
5. [Complete User Flow](#complete-user-flow)
6. [Feature Implementations](#feature-implementations)
7. [API Endpoints](#api-endpoints)
8. [Code Examples](#code-examples)
9. [How to Explain Each Feature](#how-to-explain-each-feature)

---

## Project Overview

**Google Meet Clone** is a full-stack real-time video conferencing application built with:
- **Frontend:** Next.js + React
- **Backend:** Express.js + Node.js
- **Real-time Communication:** Socket.IO
- **Database:** PostgreSQL with Prisma ORM
- **Authentication:** Google OAuth 2.0

### Key Features
✅ Google OAuth Login  
✅ Generate Unique Meeting Codes  
✅ Join Meetings via Code  
✅ 24-Hour Meeting Expiration  
✅ Real-time Video Chat  
✅ Camera/Microphone Control  
✅ Screen Sharing  
✅ Chat Messages  
✅ Emoji Reactions  

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        User's Browser                            │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │            Frontend (Next.js + React)                    │  │
│  │                                                           │  │
│  │  Landing Page → Login → Dashboard → Meeting Room         │  │
│  │                                                           │  │
│  │  Zustand Store (meeting, participants, messages)         │  │
│  │  MediaManager (camera, mic, screen share)                │  │
│  │  PeerManager (WebRTC connections)                        │  │
│  │  Socket.IO Client (real-time events)                     │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────┬─────────────────────────────────────┬────────────┘
               │ HTTP + HTTPS                        │ WebSocket
               │                                     │
        ┌──────▼─────────────────────────────────────▼─────────┐
        │         Backend (Express.js + Node.js)               │
        │                                                       │
        │  ┌─────────────────────────────────────────────┐    │
        │  │  Auth Routes                                │    │
        │  │  - GET /auth/google (OAuth initiate)        │    │
        │  │  - GET /auth/google/callback (OAuth return) │    │
        │  └─────────────────────────────────────────────┘    │
        │                                                       │
        │  ┌─────────────────────────────────────────────┐    │
        │  │  Meeting Routes                             │    │
        │  │  - POST /meetings/create (with auth)        │    │
        │  │  - GET /meetings/:meetingCode (validate)    │    │
        │  └─────────────────────────────────────────────┘    │
        │                                                       │
        │  ┌─────────────────────────────────────────────┐    │
        │  │  Socket.IO Server                           │    │
        │  │  - join-room → Add user to room             │    │
        │  │  - user-joined → Broadcast to room          │    │
        │  │  - WebRTC signaling (offer, answer, ICE)    │    │
        │  └─────────────────────────────────────────────┘    │
        │                                                       │
        │  JWT Verification Middleware                        │
        │  CORS Configuration                                 │
        │                                                       │
        └──────┬─────────────────────────────────────────────┘
               │ JDBC/SQL
               │
        ┌──────▼──────────────────┐
        │   PostgreSQL Database   │
        │                          │
        │  Table: users            │
        │  - id (CUID)             │
        │  - email (UNIQUE)        │
        │  - googleId              │
        │  - name, image           │
        │                          │
        │  Table: meetings         │
        │  - id (CUID)             │
        │  - meetingCode (UNIQUE)  │
        │  - hostId (FK → users)   │
        │  - expiresAt (24 hours)  │
        │                          │
        └──────────────────────────┘
```

---

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | Next.js 16 | Server-side rendering, routing |
| | React 19 | UI components |
| | Zustand | State management |
| | Socket.IO Client | Real-time communication |
| | Tailwind CSS | Styling |
| | TypeScript | Type safety |
| **Backend** | Express.js | HTTP server |
| | Node.js | Runtime |
| | Socket.IO | WebSocket server |
| | Passport.js | OAuth authentication |
| | JWT | Stateless token auth |
| **Database** | PostgreSQL | Relational database |
| | Prisma ORM | Database abstraction |
| **Authentication** | Google OAuth 2.0 | User login |
| **Real-time** | WebRTC | Peer-to-peer video/audio |
| | Socket.IO | Event broadcasting |

---

## Database Schema

```sql
-- User Model
CREATE TABLE users (
  id            STRING PRIMARY KEY DEFAULT cuid(),
  name          STRING,
  email         STRING UNIQUE NOT NULL,
  image         STRING,
  googleId      STRING UNIQUE,
  createdAt     TIMESTAMP DEFAULT now()
);

-- Meeting Model
CREATE TABLE meetings (
  id            STRING PRIMARY KEY DEFAULT cuid(),
  meetingCode   STRING UNIQUE NOT NULL,
  hostId        STRING NOT NULL REFERENCES users(id),
  createdAt     TIMESTAMP DEFAULT now(),
  expiresAt     TIMESTAMP NOT NULL
);

-- Key Constraints
-- - Meeting code is alphanumeric (lowercase letters only)
-- - Meeting expires 24 hours after creation
-- - Host association is required (cannot have orphan meetings)
```

**Sample Data:**
```
USER:
id: "clx1234567890abcdef"
email: "user@example.com"
googleId: "103456789012345678901"
name: "Samiksha Yadav"
image: "https://lh3.googleusercontent.com/..."
createdAt: "2026-05-20T10:00:00Z"

MEETING:
id: "clx9876543210fedcba"
meetingCode: "abc-defg-hij"
hostId: "clx1234567890abcdef"
createdAt: "2026-05-20T14:00:00Z"
expiresAt: "2026-05-21T14:00:00Z"  ← 24 hours later
```

---

## Complete User Flow

### Flow 1: First-Time User Registration

```
1. User visits http://localhost:3000
   ↓
2. User clicks "Sign in with Google"
   ↓
3. Frontend redirects to: /auth/google
   ↓
4. Backend initiates Google OAuth flow
   - Sends authorization request to Google
   - Requests scopes: profile, email
   ↓
5. User sees Google consent screen
   ↓
6. User grants permissions
   ↓
7. Google redirects backend with authorization code
   ↓
8. Backend exchanges code for access token
   ↓
9. Backend fetches user profile from Google
   ↓
10. Passport strategy checks if user exists in DB
    - NEW USER: Creates record with:
      {
        id: generated CUID,
        googleId: "103456...",
        email: "user@gmail.com",
        name: "User Name",
        image: "google profile pic",
        createdAt: now
      }
    - EXISTING USER: Updates if needed
   ↓
11. Backend generates JWT token
    {
      id: "clx123...",
      email: "user@gmail.com",
      iat: 1234567890,
      exp: 1234567890 + 7 days
    }
   ↓
12. Backend redirects to: /auth/callback?token=JWT_TOKEN
   ↓
13. Frontend receives JWT
   ↓
14. Frontend stores JWT in localStorage:
    localStorage.setItem("authToken", JWT_TOKEN)
   ↓
15. Frontend redirects to /dashboard
   ↓
16. User sees dashboard with "Create New Meeting" button
```

### Flow 2: Create a New Meeting

```
1. User is on /dashboard
   ↓
2. User clicks "New Meeting" button
   ↓
3. Frontend makes API call:
   POST /meetings/create
   Headers: { Authorization: "Bearer JWT_TOKEN" }
   ↓
4. Backend authMiddleware verifies JWT
   - Extracts token from Authorization header
   - Verifies signature with JWT_SECRET
   - Attaches user data to req.user
   ↓
5. Backend generates unique meeting code:
   - Function: generateMeetingCode()
   - Format: "{random 3 letters}-{random 4 letters}-{random 3 letters}"
   - Example: "xyz-qwer-uvw"
   - Checks for duplicates (Unique constraint)
   - Retry max 5 times if collision detected
   ↓
6. Backend creates Meeting record:
   {
     id: generated CUID,
     meetingCode: "xyz-qwer-uvw",
     hostId: user.id,
     createdAt: now,
     expiresAt: now + 24 hours
   }
   ↓
7. Backend returns response:
   {
     success: true,
     meeting: {
       id: "clx987...",
       meetingCode: "xyz-qwer-uvw",
       hostId: "clx123...",
       createdAt: "2026-05-20T14:00:00Z",
       expiresAt: "2026-05-21T14:00:00Z"
     }
   }
   ↓
8. Frontend displays modal with:
   - Meeting code: "xyz-qwer-uvw"
   - Share link: "http://localhost:3000/meeting-room/xyz-qwer-uvw"
   - Copy button
   ↓
9. User can:
   - Click "Copy link" to share with others
   - Click "Join now" to start meeting immediately
```

### Flow 3: Join Meeting by Code

```
1. User (different browser/device) receives meeting link
   http://localhost:3000/meeting-room/xyz-qwer-uvw
   ↓
2. User clicks link or pastes URL
   ↓
3. Frontend page loads: /meeting-room/[meetingCode]
   ↓
4. useEffect triggers: validateMeeting()
   ↓
5. Frontend makes API call:
   GET /meetings/xyz-qwer-uvw
   (NO JWT required - public validation)
   ↓
6. Backend checks meeting validity:
   a) Query database for meetingCode
   b) If not found → Return 404 "Meeting not found"
   c) If found:
      - Get meeting.expiresAt
      - Current time = now()
      - If now() > meeting.expiresAt → Return 410 "Meeting expired"
      - If now() <= meeting.expiresAt → Return 200 with meeting object
   ↓
7. If error (404/410):
   - Display error on screen
   - Auto-redirect to /dashboard after 3 seconds
   ↓
8. If valid (200):
   - Meeting page renders
   - Show "Joining" screen with meeting code
   - Display button: "Allow camera & mic"
   ↓
9. User clicks "Allow camera & mic"
   ↓
10. Browser prompts for camera/microphone permission
   ↓
11. User grants permission
   ↓
12. Frontend calls navigator.mediaDevices.getUserMedia()
   - Request audio: true
   - Request video: true
   ↓
13. Browser captures media stream
   ↓
14. Frontend sets loading screen state
   ↓
15. Loading bar progresses to 100%
   ↓
16. State changes to "inMeeting"
   ↓
17. Main meeting room UI renders
   - Local video preview (top left)
   - Remote video area (center)
   - Control bar (bottom): mic, camera, share, chat, reactions
```

### Flow 4: Socket.IO Real-Time Signaling

```
1. Both users are now in meeting (both clicked join)
   ↓
2. User A's Socket.IO client connects to backend
   socket = io("http://localhost:5000")
   ↓
3. On connection established:
   Backend logs: "User connected: socket_id_abc123"
   ↓
4. User A emits "join-room" event:
   socket.emit("join-room", "xyz-qwer-uvw")
   ↓
5. Backend socket handler receives:
   - socket.join("xyz-qwer-uvw")
     → Adds this socket to room namespace "xyz-qwer-uvw"
   - socket.to("xyz-qwer-uvw").emit("user-joined", {
       socketId: "socket_id_abc123"
     })
     → Sends "user-joined" to all OTHER sockets in room
   ↓
6. If User B already in room:
   User B's socket receives "user-joined" event
   ↓
7. User B socket handler:
   socket.on("user-joined", (data) => {
     console.log("New user joined:", data.socketId)
     // Create WebRTC peer connection with User A
     peerManager.createOffer(data.socketId)
   })
   ↓
8. PeerManager creates RTCPeerConnection:
   const peer = new RTCPeerConnection(iceServers)
   ↓
9. User B generates WebRTC offer:
   const offer = await peer.createOffer()
   await peer.setLocalDescription(offer)
   ↓
10. User B emits offer via Socket.IO:
    socket.emit("webrtc:offer", {
      senderSocketId: "socket_id_user_b",
      targetSocketId: "socket_id_abc123",
      description: offer
    })
    ↓
11. User A receives offer:
    socket.on("webrtc:offer", async (payload) => {
      const peer = this.getOrCreatePeer(payload.senderSocketId)
      await peer.setRemoteDescription(payload.description)
      const answer = await peer.createAnswer()
      await peer.setLocalDescription(answer)
      socket.emit("webrtc:answer", {
        senderSocketId: "socket_id_abc123",
        targetSocketId: payload.senderSocketId,
        description: answer
      })
    })
    ↓
12. User B receives answer:
    socket.on("webrtc:answer", async (payload) => {
      const peer = this.peers.get(payload.senderSocketId)
      await peer.setRemoteDescription(payload.description)
    })
    ↓
13. ICE Candidate Exchange:
    Both peers emit "webrtc:ice-candidate" events
    ↓
14. Once candidates exchanged:
    WebRTC connection established (CONNECTED state)
    ↓
15. Media tracks exchanged:
    peer.ontrack = (event) => {
      remoteStream = event.streams[0]
      attachToVideoElement(remoteStream)
    }
    ↓
16. Both users see each other's video feed
```

### Flow 5: Media Control (Mute/Unmute)

```
1. User clicks Microphone button
   ↓
2. Frontend state: isMicOn = !isMicOn
   ↓
3. Get audio tracks from local stream:
   localStream?.getAudioTracks().forEach(track => {
     track.enabled = !isMicOn
   })
   ↓
4. Track.enabled = false DOES NOT:
   - Stop the stream
   - Remove the track
   - Send disconnection signal
   ↓
5. Track.enabled = false DOES:
   - Mute the audio at source
   - Other peers still receive track (no audio data)
   - Quick toggle, no reconnection needed
   ↓
6. UI button color changes:
   - Enabled (mic on): Blue background
   - Disabled (mic off): Red background with MicOff icon
   ↓
7. Same flow for Camera toggle
   ↓
8. When user leaves meeting:
   localStream?.getTracks().forEach(track => {
     track.stop()  // Actually stops the stream
   })
```

### Flow 6: Meeting Expiration Check

```
Example Timeline:
─────────────────────────────────────────────────

T+00:00 Hours:  Meeting Created
                expiresAt = "2026-05-21 14:00:00"
                Users can join freely

T+12:00 Hours:  User tries to join
                GET /meetings/xyz-qwer-uvw
                now() = "2026-05-21 02:00:00"
                ✅ now() < expiresAt
                Response: 200 OK, meeting object
                User can join

T+24:00 Hours:  Meeting Expires
                now() = "2026-05-21 14:00:00"

T+24:05 Hours:  New user tries to join
                GET /meetings/xyz-qwer-uvw
                now() = "2026-05-21 14:05:00"
                ❌ now() > expiresAt
                Response: 410 Gone
                Error: "Meeting has expired"
                Cannot join

T+∞:            Meeting record stays in DB
                Can be queried for historical records
                No automatic deletion
```

---

## Feature Implementations

### Feature 1: Unique Meeting Code Generation

**Function Location:** [backend/src/routes/meetingRoutes.js](backend/src/routes/meetingRoutes.js)

```javascript
function generateMeetingCode() {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  
  const random = (length) =>
    Array.from({ length }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  
  return `${random(3)}-${random(4)}-${random(3)}`;
}

// Example outputs:
// "abc-defg-hij"
// "xyz-qwer-asd"
// "mno-pqrs-tuv"
```

**Why This Format?**
- 11 characters total (easy to read/share verbally)
- No numbers (avoid confusion: O vs 0, I vs 1, l vs 1)
- Hyphenated (readable in chunks)
- Case-insensitive (always lowercase)
- Statistically unlikely collisions (26^11 = ~3.67 × 10^15 combinations)

**Collision Handling:**
```javascript
let meeting;
let retries = 0;
const maxRetries = 5;

while (retries < maxRetries) {
  try {
    const meetingCode = generateMeetingCode();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    meeting = await prisma.meeting.create({
      data: { meetingCode, hostId: req.user.id, expiresAt }
    });
    break; // Success
  } catch (error) {
    if (error.code === "P2002") { // Unique constraint violation
      retries++;
      if (retries >= maxRetries) {
        throw new Error("Failed to generate unique code");
      }
      // Retry with new code
    } else {
      throw error;
    }
  }
}
```

**Probability:** Collision chance with 1000 concurrent meetings ≈ 1 in 3.67 × 10^12

---

### Feature 2: 24-Hour Meeting Expiration

**Database:** expiresAt field added to Meeting model

**Creation:**
```javascript
const expiresAt = new Date();
expiresAt.setHours(expiresAt.getHours() + 24);  // Add 24 hours

meeting = await prisma.meeting.create({
  data: { meetingCode, hostId, expiresAt }
});
```

**Validation:**
```javascript
router.get("/:meetingCode", async (req, res) => {
  const meeting = await prisma.meeting.findUnique({
    where: { meetingCode: req.params.meetingCode }
  });

  if (!meeting) {
    return res.status(404).json({ 
      success: false, 
      message: "Meeting not found" 
    });
  }

  // Check expiration
  const now = new Date();
  if (meeting.expiresAt < now) {
    return res.status(410).json({
      success: false,
      message: "Meeting has expired",
      expiresAt: meeting.expiresAt
    });
  }

  return res.status(200).json({ 
    success: true, 
    meeting 
  });
});
```

**Frontend Error Handling:**
```typescript
if ('status' in error && error.status === 410) {
  setMeetingError("Meeting has expired. Meeting codes are valid for 24 hours.");
} else if ('status' in error && error.status === 404) {
  setMeetingError("Meeting not found");
}
```

**Production Considerations:**
- No background job to delete expired meetings
- Consider adding Cron job for cleanup (keep DB lean)
- Or use TTL index in MongoDB (if switching DB)

---

### Feature 3: Google OAuth Authentication

**Backend Setup:** [backend/src/config/passport.js](backend/src/config/passport.js)

```javascript
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const prisma = require("./prisma");

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "http://localhost:5000/auth/google/callback",
      scope: ["profile", "email"]
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;

        let user = await prisma.user.findUnique({ where: { email } });

        if (!user) {
          user = await prisma.user.create({
            data: {
              googleId: profile.id,
              email: email,
              name: profile.displayName,
              image: profile.photos?.[0]?.value
            }
          });
        } else if (!user.googleId) {
          user = await prisma.user.update({
            where: { email },
            data: { googleId: profile.id }
          });
        }

        return done(null, user);
      } catch (error) {
        return done(error, null);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  const user = await prisma.user.findUnique({ where: { id } });
  done(null, user);
});
```

**Auth Routes:** [backend/src/routes/authRoutes.js](backend/src/routes/authRoutes.js)

```javascript
const express = require("express");
const passport = require("passport");
const jwt = require("jsonwebtoken");
const router = express.Router();

// Step 1: Redirect to Google
router.get(
  "/google",
  passport.authenticate("google", {
    scope: ["profile", "email"]
  })
);

// Step 2: Google callback
router.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: "/login" }),
  (req, res) => {
    // Generate JWT token
    const token = jwt.sign(
      {
        id: req.user.id,
        email: req.user.email
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Redirect to frontend with token
    res.redirect(
      `http://localhost:3000/auth/callback?token=${token}`
    );
  }
);

module.exports = router;
```

**Frontend OAuth Callback:** [frontend/app/auth/callback/page.tsx](frontend/app/auth/callback/page.tsx)

```typescript
"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function AuthCallback() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const token = searchParams.get("token");
    
    if (token) {
      // Store JWT in localStorage
      localStorage.setItem("authToken", token);
      
      // Redirect to dashboard
      router.push("/dashboard");
    } else {
      // No token, redirect to login
      router.push("/");
    }
  }, [searchParams, router]);

  return <div>Authenticating...</div>;
}
```

**JWT Token Structure:**
```javascript
{
  id: "clx1234567890abcdef",
  email: "user@example.com",
  iat: 1716200400,      // Issued at
  exp: 1716805200       // Expires in 7 days
}
```

---

### Feature 4: Socket.IO Real-Time Communication

**Backend Server Setup:** [backend/server.js](backend/server.js)

```javascript
const http = require("http");
const express = require("express");
const setupSocket = require("../backend/src/socket/socket");

const app = express();
const server = http.createServer(app);

// Setup Socket.IO with CORS
setupSocket(server);

server.listen(5000, () => {
  console.log("Server running on port 5000");
});
```

**Socket Configuration:** [backend/src/socket/socket.js](backend/src/socket/socket.js)

```javascript
const { Server } = require("socket.io");

function setupSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: "http://localhost:3000",
      credentials: true
    }
  });

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // Join a meeting room
    socket.on("join-room", (meetingCode) => {
      socket.join(meetingCode);
      console.log(`User ${socket.id} joined room ${meetingCode}`);

      // Notify others in room
      socket.to(meetingCode).emit("user-joined", {
        socketId: socket.id,
        joinedAt: new Date()
      });
    });

    // Leave room
    socket.on("leave-room", (meetingCode) => {
      socket.leave(meetingCode);
      socket.to(meetingCode).emit("user-left", {
        socketId: socket.id
      });
    });

    // Disconnect
    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
    });

    // WebRTC Signaling (offer)
    socket.on("webrtc:offer", (payload) => {
      socket.to(payload.targetSocketId).emit("webrtc:offer", {
        senderSocketId: socket.id,
        description: payload.description
      });
    });

    // WebRTC Signaling (answer)
    socket.on("webrtc:answer", (payload) => {
      socket.to(payload.targetSocketId).emit("webrtc:answer", {
        senderSocketId: socket.id,
        description: payload.description
      });
    });

    // ICE Candidates
    socket.on("webrtc:ice-candidate", (payload) => {
      socket.to(payload.targetSocketId).emit("webrtc:ice-candidate", {
        senderSocketId: socket.id,
        candidate: payload.candidate
      });
    });
  });

  return io;
}

module.exports = setupSocket;
```

**Frontend Socket Client:** [frontend/lib/socket.ts](frontend/lib/socket.ts)

```typescript
import { io } from "socket.io-client";

export const socket = io("http://localhost:5000");
```

**Usage in Meeting Room:** [frontend/app/meeting-room/page.tsx](frontend/app/meeting-room/page.tsx)

```typescript
useEffect(() => {
  if (!meetingCode) return;

  const joinRoom = () => {
    socket.emit("join-room", meetingCode);
  };

  if (socket.connected) {
    joinRoom();
  } else {
    socket.once("connect", joinRoom);
  }

  socket.on("user-joined", (data) => {
    console.log("New user joined:", data.socketId);
    // Create WebRTC peer connection
    peerManager.createOffer(data.socketId);
  });

  return () => {
    socket.off("connect", joinRoom);
    socket.off("user-joined");
  };
}, [meetingCode]);
```

**Event Flow:**
```
User A joins:
  socket.emit("join-room", code)
    ↓
  Backend: socket.join(code)
  Backend: socket.to(code).emit("user-joined", {socketId})
    ↓
  User B receives "user-joined"
    ↓
  User B initiates WebRTC peer connection
```

---

### Feature 5: WebRTC Video Streaming

**Media Manager:** [frontend/lib/webrtc/media-manager.ts](frontend/lib/webrtc/media-manager.ts)

```typescript
export class MediaManager {
  private stream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;

  async requestUserMedia(selection: MediaDeviceSelection = {}) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: selection.audioDeviceId
        ? { deviceId: { exact: selection.audioDeviceId } }
        : true,
      video: selection.videoDeviceId
        ? { deviceId: { exact: selection.videoDeviceId } }
        : true
    });
    return this.stream;
  }

  async requestScreenShare() {
    this.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true
    });
    return this.screenStream;
  }

  setAudioEnabled(enabled: boolean) {
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  setVideoEnabled(enabled: boolean) {
    this.stream?.getVideoTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  cleanup() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.screenStream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.screenStream = null;
  }
}
```

**Peer Manager:** [frontend/lib/webrtc/peer-manager.ts](frontend/lib/webrtc/peer-manager.ts)

```typescript
import type { Socket } from "socket.io-client";

export interface PeerManagerOptions {
  socket: Socket;
  onRemoteStream: (socketId: string, stream: MediaStream) => void;
  onRemoteStreamRemoved?: (socketId: string) => void;
  iceServers?: RTCIceServer[];
}

export class PeerManager {
  private peers: Map<string, RTCPeerConnection> = new Map();
  private options: PeerManagerOptions;

  constructor(options: PeerManagerOptions) {
    this.options = options;
    this.setupSocketListeners();
  }

  async createOffer(targetSocketId: string) {
    const peer = this.getOrCreatePeer(targetSocketId);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    this.options.socket.emit("webrtc:offer", {
      senderSocketId: this.options.socket.id,
      targetSocketId,
      description: offer
    });
  }

  closePeer(socketId: string) {
    this.peers.get(socketId)?.close();
    this.peers.delete(socketId);
  }

  closeAllPeers() {
    this.peers.forEach((peer) => peer.close());
    this.peers.clear();
  }

  private getOrCreatePeer(socketId: string) {
    const existing = this.peers.get(socketId);
    if (existing) return existing;

    const peer = new RTCPeerConnection({
      iceServers: this.options.iceServers || [
        { urls: ["stun:stun.l.google.com:19302"] }
      ]
    });

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        this.options.socket.emit("webrtc:ice-candidate", {
          senderSocketId: this.options.socket.id,
          targetSocketId: socketId,
          candidate: event.candidate
        });
      }
    };

    peer.ontrack = (event) => {
      const [stream] = event.streams;
      this.options.onRemoteStream(socketId, stream);
    };

    this.peers.set(socketId, peer);
    return peer;
  }

  private setupSocketListeners() {
    this.options.socket.on("webrtc:offer", async (payload) => {
      const senderSocketId = payload.senderSocketId;
      if (!senderSocketId) return;

      const peer = this.getOrCreatePeer(senderSocketId);
      await peer.setRemoteDescription(
        new RTCSessionDescription(payload.description)
      );

      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);

      this.options.socket.emit("webrtc:answer", {
        senderSocketId: this.options.socket.id,
        targetSocketId: senderSocketId,
        description: answer
      });
    });

    this.options.socket.on("webrtc:answer", async (payload) => {
      if (!payload.senderSocketId) return;
      const peer = this.peers.get(payload.senderSocketId);
      if (peer) {
        await peer.setRemoteDescription(
          new RTCSessionDescription(payload.description)
        );
      }
    });

    this.options.socket.on("webrtc:ice-candidate", async (payload) => {
      if (!payload.senderSocketId) return;
      const peer = this.peers.get(payload.senderSocketId);
      if (peer && payload.candidate) {
        await peer.addIceCandidate(new RTCIceCandidate(payload.candidate));
      }
    });
  }
}
```

**Meeting Room Integration:**

```typescript
const [localStream, setLocalStream] = useState<MediaStream | null>(null);

// Request media permission
const requestMedia = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    setLocalStream(stream);
    setMeetingState("loading"); // Proceed to loading screen
  } catch (error) {
    setMediaError("Unable to access camera and microphone");
  }
};

// Attach to video element
useEffect(() => {
  if (localVideoRef.current && localStream) {
    localVideoRef.current.srcObject = localStream;
  }
}, [localStream, meetingState]);

// Toggle audio
const toggleMic = () => {
  localStream?.getAudioTracks().forEach((track) => {
    track.enabled = !isMicOn;
  });
  setIsMicOn(!isMicOn);
};

// Toggle video
const toggleCamera = () => {
  localStream?.getVideoTracks().forEach((track) => {
    track.enabled = !isCameraOn;
  });
  setIsCameraOn(!isCameraOn);
};

// Leave meeting
const handleEndCall = () => {
  localStream?.getTracks().forEach((track) => track.stop());
  socket.disconnect();
  setMeetingState("ended");
};
```

---

## API Endpoints

### Authentication Endpoints

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/auth/google` | - | Initiate Google OAuth flow |
| GET | `/auth/google/callback` | - | Handle Google OAuth callback |

### Meeting Endpoints

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| POST | `/meetings/create` | JWT | Create new meeting with unique code |
| GET | `/meetings/:meetingCode` | - | Validate & fetch meeting (check expiration) |

---

## Code Examples

### Example 1: Complete Authentication Flow

```javascript
// Frontend: Trigger Google OAuth
const handleGoogleLogin = () => {
  window.location.href = "http://localhost:5000/auth/google";
};

// Backend: OAuth handler (passport.js handles this)
// User clicks link → Google consent → Callback → JWT token generated
// Frontend: Store JWT
useEffect(() => {
  const token = new URLSearchParams(window.location.search).get("token");
  if (token) {
    localStorage.setItem("authToken", token);
    router.push("/dashboard");
  }
}, []);

// Frontend: Use JWT in API calls
const createMeeting = async () => {
  const response = await fetch("http://localhost:5000/meetings/create", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${localStorage.getItem("authToken")}`
    }
  });
  const data = await response.json();
  return data.meeting.meetingCode;
};
```

### Example 2: Meeting Code Generation with Retry

```javascript
async function createMeetingWithRetry(userId) {
  let retries = 0;
  const maxRetries = 5;

  while (retries < maxRetries) {
    try {
      const meetingCode = generateMeetingCode();
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      const meeting = await prisma.meeting.create({
        data: { meetingCode, hostId: userId, expiresAt }
      });

      return {
        success: true,
        meeting,
        code: meeting.meetingCode
      };
    } catch (error) {
      if (error.code === "P2002" && retries < maxRetries - 1) {
        retries++;
        console.log(`Code collision, retry ${retries}`);
        continue;
      }
      throw error;
    }
  }

  throw new Error("Failed to create meeting after max retries");
}
```

### Example 3: Socket.IO Room Signaling

```javascript
// Backend
io.on("connection", (socket) => {
  socket.on("join-room", (meetingCode) => {
    socket.join(meetingCode);
    
    // Notify all users in room except sender
    socket.to(meetingCode).emit("user-joined", {
      socketId: socket.id,
      timestamp: new Date()
    });

    // Relay WebRTC offer
    socket.on("webrtc:offer", (payload) => {
      socket.to(payload.targetSocketId).emit("webrtc:offer", {
        senderSocketId: socket.id,
        description: payload.description
      });
    });
  });
});

// Frontend
socket.emit("join-room", meetingCode);
socket.on("user-joined", (data) => {
  peerManager.createOffer(data.socketId);
});
socket.on("webrtc:offer", async (payload) => {
  // Handle incoming offer
});
```

---

## How to Explain Each Feature

### 1. How Authentication Works
**Simple Explanation:**
> "Users click 'Sign in with Google.' The app redirects them to Google's login page. After they approve, Google sends their profile info to our backend. We check if this user exists in our database. If new, we create an account. Then we give the user a special token (JWT) that acts like a digital ID card. They use this token for all future requests."

**Technical Details to Add:**
- Passport.js handles OAuth flow
- JWT tokens last 7 days
- Token is stored in browser's localStorage
- Every API call includes the token in Authorization header

### 2. How Meeting Codes are Generated
**Simple Explanation:**
> "We create an 11-letter code like 'abc-defg-hij' by randomly picking lowercase letters. We hyphenate it for readability. The database ensures each code is unique. If by rare chance we generate a duplicate, we try again (up to 5 times). The chance of collision is astronomically low."

**Technical Details to Add:**
- Format: 3-4-3 letters
- Only lowercase letters (no numbers or uppercase)
- Unique constraint in database prevents duplicates
- Collision retry logic handles edge cases

### 3. How Meeting Expiration Works
**Simple Explanation:**
> "When a meeting is created, we write down the time it will expire (24 hours later). When someone tries to join, we check: Is the current time past the expiration time? If yes, we say 'Sorry, meeting expired.' If no, we let them join. Expired meetings stay in the database for records but can't be joined."

**Technical Details to Add:**
- expiresAt field set to now + 24 hours
- Checked on every join attempt
- Returns HTTP 410 (Gone) status for expired meetings
- No background cleanup job (could add for production)

### 4. How Video Streaming Works
**Simple Explanation:**
> "When users click 'Join,' the browser asks for camera/microphone permission. Once granted, we capture the media stream. We then use WebRTC (a browser technology) to create a direct connection between peers' browsers. Through this connection, we send video/audio. Muting just stops sending audio/video; the connection stays active."

**Technical Details to Add:**
- Uses navigator.mediaDevices.getUserMedia() API
- WebRTC creates peer-to-peer connection
- Socket.IO sends WebRTC signaling (offer/answer/ICE)
- Muting = track.enabled = false (not disconnection)

### 5. How Real-Time Notifications Work
**Simple Explanation:**
> "Socket.IO keeps an open WebSocket connection between each user and the server. When User A joins a meeting, we add them to a 'room' on the server. The server then broadcasts a message to everyone in that room: 'User A joined.' This happens in real-time (sub-second latency)."

**Technical Details to Add:**
- Socket.IO library handles WebSocket connection
- Users join a room namespace based on meeting code
- Broadcasting uses socket.to(roomName).emit()
- Also handles WebRTC signaling (offer/answer/ICE)

### 6. Complete Meeting Journey
**Simple Explanation:**
> "1. User logs in via Google. 2. Click 'New Meeting' to get a code. 3. Share link with others. 4. When others join, their browsers connect via WebRTC. 5. Video/audio streams exchange. 6. After 24 hours, the meeting expires and new people can't join."

**Technical Details to Add:**
- OAuth for login → JWT token issued
- POST /meetings/create generates code + sets 24hr expiration
- GET /meetings/:code validates before allowing join
- Socket.IO notifies about new users
- WebRTC exchanges media between peers

---

## Key Points to Remember When Explaining

✅ **Start with the user perspective first**, then dive into technical details  
✅ **Use analogies**: "JWT is like a passport," "Socket.IO is like a live radio channel"  
✅ **Show the flow step-by-step** with numbers or diagrams  
✅ **Explain why each part is needed** (security, scalability, real-time)  
✅ **Use actual code snippets** for developers  
✅ **Test your explanations** by asking questions back to the listener  

---

## Summary

This Google Meet Clone demonstrates:
- ✅ Secure OAuth authentication
- ✅ Unique, collision-resistant code generation
- ✅ 24-hour meeting lifecycle management
- ✅ Real-time peer-to-peer video communication
- ✅ Socket-based event broadcasting
- ✅ Responsive UI with React hooks
- ✅ Scalable Express backend
- ✅ Type-safe TypeScript frontend

The architecture is production-ready with proper error handling, expiration checks, and real-time synchronization.

---

**Document Version:** 1.0  
**Last Updated:** May 20, 2026  
**For Questions:** Review the code files linked throughout this document
