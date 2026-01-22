#!/usr/bin/env node

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { google } from "googleapis";

/* --------------------------------------------------
   ENV SETUP
-------------------------------------------------- */
dotenv.config({ path: "./credentials.env" });

const app = express();
const PORT = 5000;

app.use(bodyParser.json());

/* --------------------------------------------------
   GOOGLE OAUTH CONFIG
-------------------------------------------------- */
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:5000/oauth2callback";

const SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses",
  "https://www.googleapis.com/auth/classroom.announcements",
  "https://www.googleapis.com/auth/classroom.coursework.students",
  "https://www.googleapis.com/auth/classroom.rosters"
];

/* --------------------------------------------------
   OAUTH CLIENT (STATELESS)
-------------------------------------------------- */
function getOAuthClient() {
  const client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );

  client.setCredentials({
    access_token: process.env.ACCESS_TOKEN,
    refresh_token: process.env.REFRESH_TOKEN
  });

  return client;
}

/* --------------------------------------------------
   GOOGLE CLASSROOM CLIENT
-------------------------------------------------- */
function getClassroomClient() {
  return google.classroom({
    version: "v1",
    auth: getOAuthClient()
  });
}

/* --------------------------------------------------
   AUTH ROUTES (ONE-TIME USE)
-------------------------------------------------- */
app.get("/auth", (req, res) => {
  const client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES
  });

  res.redirect(authUrl);
});

app.get("/oauth2callback", async (req, res) => {
  const { code } = req.query;

  const client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );

  const { tokens } = await client.getToken(code);

  console.log("ACCESS_TOKEN =", tokens.access_token);
  console.log("REFRESH_TOKEN =", tokens.refresh_token);

  res.send(`
    ✅ Authentication successful.<br/><br/>
    Copy the printed ACCESS_TOKEN and REFRESH_TOKEN<br/>
    into your credentials.env file.
  `);
});

/* --------------------------------------------------
   🔐 ROLE DETECTION (NEW)
-------------------------------------------------- */
async function getUserRoleInCourse(classroom, courseId) {
  try {
    await classroom.courses.teachers.get({
      courseId,
      userId: "me"
    });
    return "TEACHER";
  } catch {
    return "STUDENT";
  }
}

/* --------------------------------------------------
   🔐 ROLE → TOOL ACCESS MAP (NEW)
-------------------------------------------------- */
const TOOL_ACCESS = {
  list_courses: ["TEACHER", "STUDENT"],
  get_course: ["TEACHER", "STUDENT"],
  list_students: ["TEACHER"],
  create_course: ["TEACHER"],
  create_assignment: ["TEACHER"]
};

/* --------------------------------------------------
   MCP TOOL EXECUTION ENDPOINT
-------------------------------------------------- */
app.post("/api/v1/mcp/process_message", async (req, res) => {
  try {
    const { selected_servers, client_details } = req.body;

    if (!selected_servers?.includes("GCLS_MCP")) {
      return res.status(400).json({
        error: "GCLS_MCP not selected",
        isError: true
      });
    }

    if (!client_details?.input) {
      return res.status(400).json({
        error: "Missing tool input",
        isError: true
      });
    }

    let toolCall;
    try {
      toolCall = JSON.parse(client_details.input);
    } catch {
      return res.status(400).json({
        error: "Invalid tool call JSON",
        isError: true
      });
    }

    const { name, arguments: args } = toolCall;
    const classroom = getClassroomClient();

    /* --------------------------------------------------
       🔐 ROLE CHECK (NEW)
    -------------------------------------------------- */
    let role = "TEACHER"; // default for non-course tools

    if (args?.courseId) {
      role = await getUserRoleInCourse(classroom, args.courseId);
    }

    if (!TOOL_ACCESS[name]?.includes(role)) {
      return res.status(403).json({
        error: `Access denied: ${role} cannot execute ${name}`,
        isError: true
      });
    }

    let result;

    /* ---------------- TOOL SWITCH ---------------- */
    switch (name) {

      case "list_courses": {
        const data = await classroom.courses.list({ pageSize: 50 });
        result = data.data.courses || [];
        break;
      }

      case "get_course": {
        const data = await classroom.courses.get({
          id: args.courseId
        });
        result = data.data;
        break;
      }

      case "create_course": {
        const data = await classroom.courses.create({
          requestBody: {
            name: args.name,
            section: args.section || "",
            description: args.description || "",
            ownerId: "me",
            courseState: "PROVISIONED" // 🔐 policy-compliant
          }
        });
        result = data.data;
        break;
      }

      case "list_students": {
        const data = await classroom.courses.students.list({
          courseId: args.courseId
        });
        result = data.data.students || [];
        break;
      }

      case "create_assignment": {
        const data = await classroom.courses.courseWork.create({
          courseId: args.courseId,
          requestBody: {
            title: args.title,
            description: args.description || "",
            workType: "ASSIGNMENT",
            state: "PUBLISHED",
            maxPoints: args.points || 100
          }
        });
        result = data.data;
        break;
      }

      default:
        return res.status(400).json({
          error: `Unknown tool: ${name}`,
          isError: true
        });
    }

    /* ---------------- MCP RESPONSE ---------------- */
    res.json({
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: false
    });

  } catch (error) {
    console.error("MCP Error:", error);
    res.status(500).json({
      error: error.message,
      isError: true
    });
  }
});

/* --------------------------------------------------
   START SERVER
-------------------------------------------------- */
app.listen(PORT, () => {
  console.log(`✅ MCP Server running at http://localhost:${PORT}`);
  console.log(`🔐 One-time auth at http://localhost:${PORT}/auth`);
});
