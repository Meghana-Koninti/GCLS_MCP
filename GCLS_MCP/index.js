#!/usr/bin/env node

import express from 'express';
import bodyParser from 'body-parser';
import { google } from 'googleapis';
import session from 'express-session';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const app = express();
const port = 5000;
app.use(bodyParser.json());

// Session setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true in production with HTTPS
}));

// OAuth2 Configuration
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:5000/oauth2callback';
const SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses',
  'https://www.googleapis.com/auth/classroom.announcements',
  'https://www.googleapis.com/auth/classroom.coursework.students',
  'https://www.googleapis.com/auth/classroom.rosters'
];

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

// OAuth2 Routes
app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    oauth2Client.setCredentials(tokens);
    
    // Handle token refresh events
    oauth2Client.on('tokens', (newTokens) => {
      if (newTokens.refresh_token) {
        req.session.tokens.refresh_token = newTokens.refresh_token;
      }
      req.session.tokens.access_token = newTokens.access_token;
      req.session.tokens.expiry_date = newTokens.expiry_date;
    });
    
    res.send('Authentication successful! You can now use the tools.');
  } catch (error) {
    console.error('Error getting tokens:', error);
    res.status(500).send('Authentication failed');
  }
});

// Middleware to check authentication
function checkAuth(req, res, next) {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated', isError: true });
  }
  oauth2Client.setCredentials(req.session.tokens);
  next();
}

// Updated Classroom Client
async function setupClassroomClient() {
  return google.classroom({ version: 'v1', auth: oauth2Client });
}

// Root route for authentication
app.get('/', (req, res) => {
  if (req.session.tokens) {
    res.send('Authenticated! Use Postman to send requests to /api/v1/mcp/process_message');
  } else {
    res.send('<a href="/auth">Authenticate with Google</a>');
  }
});

// MCP Integration Endpoint
app.post('/api/v1/mcp/process_message', checkAuth, async (req, res) => {
  try {
    const { selected_server_credentials, client_details, selected_servers } = req.body;
    
    // Validate required parameters
    if (!selected_servers?.includes('GCLS_MCP')) {
      return res.status(400).json({ 
        error: 'GCLS_MCP server not selected',
        isError: true 
      });
    }

    if (!client_details?.input) {
      return res.status(400).json({ 
        error: 'Input is required in client_details',
        isError: true 
      });
    }

    // Parse tool call
    let toolCall;
    try {
      toolCall = JSON.parse(client_details.input);
    } catch (e) {
      return res.status(400).json({ 
        error: 'Invalid tool call format in input',
        isError: true 
      });
    }

    // Execute tool call
    const { name: toolName, arguments: toolArgs } = toolCall;
    let result;

    switch (toolName) {
      
      case 'create_classroom':
        const classroom = await setupClassroomClient();
        const course = await classroom.courses.create({
          requestBody: {
            name: toolArgs.name,
            section: toolArgs.section || '',
            descriptionHeading: toolArgs.descriptionHeading || '',
            description: toolArgs.description || '',
            room: toolArgs.room || '',
            ownerId: 'me',
            courseState: 'PROVISIONED'
          }
        });
        result = {
          id: course.data.id,
          name: course.data.name,
          enrollmentCode: course.data.enrollmentCode
        };
        break;

      case 'courses':
        const client = await setupClassroomClient();
        const courses = await client.courses.list({ pageSize: 50 });
        result = courses.data.courses || [];
        break;

      case 'course-details':
        const client2 = await setupClassroomClient();
        const courseDetails = await client2.courses.get({ id: toolArgs.courseId });
        result = {
          id: courseDetails.data.id,
          name: courseDetails.data.name,
          section: courseDetails.data.section || ''
        };
        break;

      case 'announcements':
        const announcementsClient = await setupClassroomClient();
        const announcements = await announcementsClient.courses.announcements.list({
          courseId: toolArgs.courseId,
          pageSize: toolArgs.limit || 20
        });
        result = announcements.data.announcements || [];
        break;

      case 'create_assignment':
        const assignmentClient = await setupClassroomClient();
        const assignment = await assignmentClient.courses.courseWork.create({
          courseId: toolArgs.courseId,
          requestBody: {
            title: toolArgs.title,
            description: toolArgs.description,
            workType: 'ASSIGNMENT',
            state: 'PUBLISHED',
            dueDate: toolArgs.dueDate ? {
              year: new Date(toolArgs.dueDate).getFullYear(),
              month: new Date(toolArgs.dueDate).getMonth() + 1,
              day: new Date(toolArgs.dueDate).getDate()
            } : undefined,
            maxPoints: toolArgs.points || 100
          }
        });
        result = {
          id: assignment.data.id,
          title: assignment.data.title,
          dueDate: assignment.data.dueDate
        };
        break;

      case 'roster':
        const rosterClient = await setupClassroomClient();
        const students = await rosterClient.courses.students.list({
          courseId: toolArgs.courseId,
          pageSize: 100
        });
        result = students.data.students?.map(student => ({
          userId: student.userId,
          fullName: student.profile.name.fullName,
          email: student.profile.emailAddress
        })) || [];
        break;

      case 'submissions':
        const submissionsClient = await setupClassroomClient();
        const submissions = await submissionsClient.courses.courseWork.studentSubmissions.list({
          courseId: toolArgs.courseId,
          courseWorkId: toolArgs.assignmentId,
          pageSize: 100
        });
        result = submissions.data.studentSubmissions?.map(sub => ({
          id: sub.id,
          userId: sub.userId,
          state: sub.state,
          grade: sub.assignedGrade
        })) || [];
        break;

      case 'grade_submission':
        const gradingClient = await setupClassroomClient();
        await gradingClient.courses.courseWork.studentSubmissions.patch({
          courseId: toolArgs.courseId,
          courseWorkId: toolArgs.assignmentId,
          id: toolArgs.submissionId,
          updateMask: 'assignedGrade,draftGrade',
          requestBody: {
            assignedGrade: toolArgs.grade,
            draftGrade: toolArgs.grade
          }
        });
        result = { success: true, message: "Submission graded" };
        break;

      default:
        return res.status(400).json({ 
          error: `Unknown tool: ${toolName}`,
          isError: true 
        });
    }

    // Return response
    res.json({
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: false
    });
    
  } catch (error) {
    console.error('Tool execution error:', error);
    res.status(500).json({ 
      error: error.message,
      isError: true 
    });
  }
});

// Start server
app.listen(port, () => {
  console.log(`MCP Server running at http://localhost:${port}`);
  console.log(`Authenticate at: http://localhost:${port}/auth`);
});
