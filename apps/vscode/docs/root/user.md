# RocketRide - User Documentation

## Overview

The **RocketRide Extension** transforms Visual Studio Code into a complete development environment for building and monitoring RocketRide data pipelines. Whether you're developing data processing workflows or monitoring real-time pipeline execution, this extension provides all the tools you need in a familiar, integrated environment.

---

## Table of Contents

- [SDK & Pipeline Documentation](#sdk--pipeline-documentation)
- [What is RocketRide?](#what-is-rocketride)
- [What Can Pipelines Do?](#what-can-pipelines-do)
- [Getting Started](#getting-started)
- [User Interface Overview](#user-interface-overview)
- [Common Workflows](#common-workflows)
- [Extension Features](#extension-features)
- [Tips & Best Practices](#tips--best-practices)
- [Troubleshooting](#troubleshooting)

---

## SDK & Pipeline Documentation

For building pipelines programmatically and understanding components:

### Quick Start
- **[Quick Start Guide](../api/ROCKETRIDE_QUICKSTART.md)** - Complete working examples in Python & TypeScript

### Pipeline Building
- **[Pipeline Rules & Structure](../api/ROCKETRIDE_PIPELINE_RULES.md)** - Pipeline file format, component structure, configuration
- **[Component Reference](../api/ROCKETRIDE_COMPONENT_REFERENCE.md)** - Complete catalog of all available pipeline components

### SDK Documentation
- **[Python Client API](../api/ROCKETRIDE_python_API.md)** - Complete Python SDK reference (methods, examples, async/await)
- **[TypeScript Client API](../api/ROCKETRIDE_typescript_API.md)** - Complete TypeScript SDK reference (methods, types, browser/Node.js)

### Troubleshooting
- **[Common Mistakes](../api/ROCKETRIDE_COMMON_MISTAKES.md)** - Frequent errors and how to fix them
- **[Platform Overview](../api/ROCKETRIDE_README.md)** - Core concepts and mandatory setup steps

---

## What is RocketRide?

RocketRide is a data processing framework that allows you to build complex data pipelines using visual components. Pipelines consist of **components** (readers, transformers, writers, etc.) connected together to process data from source to destination.

This VSCode extension provides:
- **Visual Pipeline Editor**: Build pipelines with drag-and-drop components
- **Real-time Monitoring**: Watch your pipelines process data in real-time
- **File Management**: Organize and navigate your pipeline files
- **Connection Management**: Connect to local or cloud RocketRide engines
- **Environment Variables**: Dynamic configuration using .env files

---

## What Can Pipelines Do?

RocketRide pipelines are powerful data processing workflows that can handle a wide variety of tasks. Here are real-world use cases:

### Document Processing & RAG (Retrieval Augmented Generation)

Build intelligent document processing systems:

- **Extract text from PDFs and images** using OCR
- **Parse complex documents** (invoices, contracts, reports) with LlamaParse
- **Split documents into chunks** for embedding and retrieval
- **Generate embeddings** using OpenAI, local transformers, or other models
- **Store in vector databases** (Chroma, Pinecone, Weaviate, Qdrant)
- **Query with natural language** and get AI-powered answers
- **Implement RAG systems** for context-aware AI responses

**Example Pipeline**: PDF → LlamaParse → Text Splitter → OpenAI Embeddings → Chroma → LLM Query → Answer

### Data Integration & ETL

Connect and transform data across systems:

- **Web scraping** with FireCrawl for automated content extraction
- **Cloud storage integration** (SharePoint, OneDrive, Google Drive, S3)
- **Database operations** (MySQL, PostgreSQL, MongoDB)
- **API integration** via webhooks and HTTP endpoints
- **Data transformation** with custom logic and filters
- **Batch processing** of large datasets
- **Scheduled data synchronization**

**Example Pipeline**: SharePoint → Filter → Transform → MySQL Database

### AI & Machine Learning Workflows

Leverage AI models for intelligent processing:

- **LLM-powered text generation** (GPT-4, Claude, Gemini, Mistral, etc.)
- **Summarization** of long documents
- **Question answering** systems
- **Sentiment analysis** and classification
- **Entity extraction** and named entity recognition
- **Translation** and multilingual processing
- **Content moderation** and filtering

**Example Pipeline**: Documents → Preprocessor → LLM (Claude) → Summarization → Output

### Privacy & Compliance

Ensure data privacy and regulatory compliance:

- **PII detection and anonymization** using GLiNER models
- **Sensitive data masking** (SSN, credit cards, emails, names)
- **Compliance workflows** (GDPR, HIPAA, CCPA)
- **Audit trails** and processing logs
- **Multilingual PII detection** (15+ language models)
- **Biomedical data anonymization**

**Example Pipeline**: Documents → OCR → Classification → Anonymization → Secure Storage

### Search & Discovery

Build powerful search systems:

- **Semantic search** using vector embeddings
- **Hybrid search** (keyword + semantic)
- **Multi-modal search** (text + images)
- **Recommendation systems** based on similarity
- **Knowledge base construction** from unstructured data
- **Faceted search** with metadata filtering

**Example Pipeline**: Content → Embedding → Vector Store → Similarity Search → Ranked Results

### Content Analysis & Classification

Automatically categorize and analyze content:

- **Document classification** into categories
- **Topic extraction** and tagging
- **Duplicate detection** using content signatures
- **Quality assessment** and scoring
- **Language detection** and routing
- **Custom taxonomy** application

**Example Pipeline**: Documents → Extract → Classify → Tag → Catalog

---

## Getting Started

### 1. Configure Your Connection

You'll see the **RocketRide** icon in the Activity Bar (left sidebar).

#### For Cloud Mode:

1. Click the **RocketRide** icon in the Activity Bar
2. In the Connection Manager panel, click **"Open Settings"**
3. Set your connection mode to **"Cloud"**
4. Enter your **API Key** (stored securely)
5. Enter your **Host URL** (e.g., `https://cloud.rocketride.ai`)
6. Click **"Save All Settings"**
7. The extension will automatically connect

#### For Local Mode:

1. Click the **RocketRide** icon in the Activity Bar
2. In the Connection Manager panel, click **"Open Settings"**
3. Set your connection mode to **"Local"**
4. Enter the path to your local engine executable
5. (Optional) Add any engine arguments
6. Click **"Save All Settings"**
7. The extension will start your local engine and connect

### 2. Create Your First Pipeline

1. In the **RocketRide** sidebar, click the **"+"** button next to "Pipeline Files"
2. Enter a name for your pipeline (e.g., `my-first-pipeline`)
3. A new `.pipe.json` file will be created
4. The visual editor opens automatically
5. Drag components from the library to the canvas
6. Connect components by clicking and dragging between connection points
7. Configure each component's properties
8. Save your pipeline (Ctrl+S / Cmd+S)

---

## User Interface Overview

### RocketRide Activity Bar

When you click the **RocketRide** icon in the Activity Bar, you'll see:

```
┌─────────────────────────────────┐
│ ROCKETRIDE                      │
├─────────────────────────────────┤
│ > CONNECTION MANAGER            │
│   Status: Connected             │
│   Mode: Cloud                   │
│   Host: cloud.rocketride.ai         │
│   [Disconnect] [Settings]       │
├─────────────────────────────────┤
│   [+] [Refresh]                 │
│ > PIPELINE FILES                │
│   pipeline1.pipe.json           │
│      └─ source1                 │
│      └─ source2                 │
│   pipeline2.pipe.json           │
│      └─ data_reader             │
└─────────────────────────────────┘
```

### Status Bar

The bottom status bar shows your connection status:

```
$(plug) Connected | $(cloud) Cloud | cloud.rocketride.ai
```

Click it for quick actions:
- Connect/Disconnect
- Reconnect
- Open Settings

### Command Palette

Access RocketRide commands via Command Palette (Ctrl+Shift+P / Cmd+Shift+P):

- **RocketRide: Open Settings** - Open settings page
- **RocketRide: Create New Pipeline** - Create new pipeline file
- **RocketRide: Open Status Page** - Open status monitor for a pipeline
- **RocketRide: Connect to Server** - Connect to RocketRide engine
- **RocketRide: Disconnect from Server** - Disconnect from engine
- **RocketRide: Refresh All** - Refresh all views

---

## Common Workflows

### Workflow 1: Building a Simple Pipeline

**Goal**: Create a pipeline that reads a CSV file, transforms data, and writes to JSON.

1. **Create the Pipeline**
   - Click **"+"** in Pipeline Files section
   - Name it `csv-to-json.pipe.json`

2. **Add Components**
   - Drag a **"File Reader"** component to the canvas
   - Configure it to read your CSV file
   - Drag a **"Transformer"** component
   - Configure transformation rules
   - Drag a **"File Writer"** component
   - Configure it to write JSON format

3. **Connect Components**
   - Click the output port of "File Reader"
   - Drag to the input port of "Transformer"
   - Click the output port of "Transformer"
   - Drag to the input port of "File Writer"

4. **Save and Test**
   - Press Ctrl+S (Cmd+S) to save
   - Right-click on the pipeline file
   - Select **"Open Status Page"**
   - Click **"Run"** to execute the pipeline

### Workflow 2: Monitoring Running Pipelines

**Goal**: Monitor a running pipeline in real-time.

1. **Connect to Cloud**
   - Ensure you're in Cloud mode
   - Verify connection status in status bar

2. **Open Status Monitor**
   - In Pipeline Files, find your pipeline
   - Expand to see source components
   - Right-click on a source component
   - Select **"Open Status Page"**

3. **View Real-time Metrics**
   - The Status page shows:
     - Current state (Running/Stopped/Error)
     - Items processed counter
     - Processing rate (items/sec)
     - Real-time rate graph
     - Error and warning logs
     - Component-level status

4. **Control Execution**
   - Click **"Stop"** to halt the pipeline
   - Click **"Run"** to start/resume
   - View endpoint information if available

5. **Analyze Performance**
   - Switch time ranges (1min, 5min, 10min, All)
   - Check average, peak, and minimum rates
   - Review error logs for issues
   - Monitor individual component throughput

### Workflow 3: Using Environment Variables

**Goal**: Create reusable pipelines with dynamic configuration.

1. **Check .env File**
   - The extension automatically creates `.env` in your workspace root with `ROCKETRIDE_URI` and `ROCKETRIDE_APIKEY`
   - Add custom variables:
   ```bash
   ROCKETRIDE_URI=https://cloud.rocketride.ai
   ROCKETRIDE_APIKEY=your-api-key-here
   ROCKETRIDE_INPUT_PATH=/data/input
   ROCKETRIDE_OUTPUT_PATH=/data/output
   ROCKETRIDE_S3_BUCKET=my-production-bucket
   ```

2. **Use Variables in Pipeline**
   - In your pipeline components, use `${ROCKETRIDE_*}` placeholders:
```json
{
     "components": {
       "s3_reader": {
         "type": "s3_reader",
         "params": {
           "bucket": "${ROCKETRIDE_S3_BUCKET}",
           "path": "${ROCKETRIDE_INPUT_PATH}"
         }
       }
     }
   }
   ```

3. **Variables are Automatically Substituted**
   - When the pipeline runs, all `${ROCKETRIDE_*}` placeholders are replaced
   - Change environments by updating `.env` file
   - No need to modify pipeline files

4. **View Current Variables**
   - Open **RocketRide Settings**
   - Check the **Environment Variables** section
   - See all loaded variables and their values

### Workflow 4: Managing Multiple Pipelines

**Goal**: Work with multiple pipelines simultaneously.

1. **Organize Pipeline Files**
   - Create subdirectories in your workspace:
     ```
     workspace/
     ├── pipelines/
     │   ├── ingestion/
     │   │   ├── csv-import.pipe.json
     │   │   └── api-import.pipe.json
     │   └── transformation/
     │       ├── data-clean.pipe.json
     │       └── data-merge.pipe.json
     ```

2. **Quick Navigation**
   - Use the Pipeline Files tree view
   - Files are automatically discovered
   - Click **Refresh** to rescan workspace

3. **Multiple Status Pages**
   - Open status pages for different pipelines
   - Each gets its own tab
   - Switch between tabs to monitor multiple pipelines

4. **Configure Default Pipeline Path**
   - Open **RocketRide Settings**
   - Set **"Default Pipeline Path"** to your preferred directory
   - New pipelines will be created there

---

## Extension Features

### Visual Pipeline Editor

The visual editor provides a graphical interface for building pipelines:

#### Component Library
- Located on the left side of the editor
- Categories: Sources, Transformers, Destinations, Utilities
- Drag components onto the canvas
- Each component type has specific capabilities
- Search and filter components by type

#### Canvas Operations
- **Pan**: Click and drag on empty space
- **Zoom**: Use mouse wheel or zoom controls
- **Select**: Click on components or connections
- **Delete**: Select and press Delete key
- **Undo/Redo**: Ctrl+S to save (Cmd+S on Mac)

#### Component Configuration
- Click on a component to select it
- Property panel appears (usually on the right)
- Edit component parameters
- Changes auto-save or manual save with Ctrl+S

#### Connection Drawing
- Click and drag from an output port
- Release on an input port
- Connections show data flow direction
- Delete connections by selecting and pressing Delete

#### Switching to Text View
- Right-click on the pipeline file in Explorer
- Select **"Open as Text"**
- Edit the raw JSON
- Switch back to visual editor as needed

### Real-time Status Monitoring

Comprehensive monitoring of pipeline execution:

#### Status Overview
- **State**: Current pipeline state (Running, Stopped, Paused, Error, etc.)
- **Elapsed Time**: How long the pipeline has been running
- **Total Items**: Total items processed
- **Failed Items**: Number of items that failed processing
- **Current Rate**: Items processed per second (real-time)

#### Processing Rate Graph
- Real-time chart showing processing throughput
- Separate lines for successful and failed items
- Time range selection: 1 minute, 5 minutes, 10 minutes, or All
- Auto-scrolling as new data arrives
- Automatic reset detection when pipeline restarts

#### Statistics Display
- **Current Rate**: Right-now processing speed
- **Average Rate**: Average over selected time range
- **Peak Rate**: Maximum rate achieved
- **Minimum Rate**: Lowest rate (excluding zeros)
- **Duration**: Total time in selected range

#### Error and Warning Logs
- Structured log display with severity levels
- Filter by: All, Errors Only, Warnings Only, Info
- Timestamp for each log entry
- Component identification for errors
- Full error messages and stack traces

#### Component Status
View status of individual pipeline components:
- Component name and type
- Current state
- Items processed
- Error count
- Processing rate

#### Pipeline Flow Visualization
Interactive diagram showing:
- All components in the pipeline
- Connections between components
- Data flow direction
- Current active components (when running)
- Bottlenecks or stopped components

#### Run/Stop Controls
- **Run Button**: Start or resume pipeline execution
- **Stop Button**: Gracefully stop the pipeline
- Button state changes based on pipeline state
- Disabled during state transitions

#### Endpoint Information
For pipelines with endpoints:
- View endpoint URLs and credentials
- Quick links to external resources
- Copy endpoint information
- Security icon for sensitive data

### Connection Management

Flexible connection options for different deployment scenarios:

#### Cloud Mode
Connect to RocketRide cloud services:
- **Host URL**: `https://cloud.rocketride.ai` (or your cloud URL)
- **API Key**: Required for authentication (stored securely)
- **WebSocket**: Uses secure WSS protocol
- **Auto-reconnect**: Automatically reconnects on disconnect

#### Local Mode
Run a local RocketRide engine:
- **Engine Path**: Path to local engine executable
- **Engine Arguments**: Additional command-line arguments
- **Auto-start**: Extension starts the engine for you
- **Port Detection**: Automatically finds the engine's port
- **Process Management**: Stops engine when extension deactivates

#### Connection Status
Monitor connection health:
- **Disconnected**: Not connected (gray icon)
- **Connecting**: Connection in progress (spinning icon)
- **Connected**: Successfully connected (green icon)
- **Error**: Connection failed (red icon)
- **Retry Attempts**: Shows retry count during reconnection

#### Manual Controls
- **Connect**: Initiate connection
- **Disconnect**: Close connection (stops auto-reconnect)
- **Reconnect**: Force reconnection
- **Test Connection**: Verify settings without full connection

### Settings Management

Comprehensive settings interface:

#### Connection Settings
- **Connection Mode**: Cloud or Local
- **Host URL**: Server address and port
- **API Key**: Secure authentication (encrypted storage)
- **Auto Connect**: Connect automatically on startup

#### Pipeline Settings
- **Default Pipeline Path**: Where new pipelines are created
- **Pipeline Restart Behavior**: What happens when pipelines change while running

#### Local Engine Settings (Local Mode Only)
- **Engine Path**: Path to engine executable
- **Engine Arguments**: Command-line arguments for engine
- **Validation**: Checks if engine exists

#### Debugging Settings
- **Threads**: Number of processing threads (1-64)
- **Just My Code**: Skip system components during debugging

#### Environment Variables
- View all loaded `.env` variables
- See current values
- Understand which variables are available for substitution

---

## Tips & Best Practices

### Pipeline Development
1. **Start Small**: Begin with simple pipelines and add complexity gradually
2. **Name Components Clearly**: Use descriptive names for easier troubleshooting
3. **Test Incrementally**: Test each component addition before moving on
4. **Monitor Early**: Open status pages while developing to watch data flow
5. **Document Configuration**: Add comments to your `.pipe.json` files

### Performance Optimization
1. **Monitor Processing Rates**: Watch the rate graph to identify bottlenecks
2. **Adjust Thread Count**: Increase threads for I/O-bound operations
3. **Check Error Rates**: High error rates indicate configuration issues
4. **Balance Pipeline Stages**: Ensure no single component is a bottleneck
5. **Use Appropriate Batch Sizes**: Configure components for optimal batch processing

### Troubleshooting Strategies
1. **Check Logs First**: Review error logs in the status page
2. **Test with Small Datasets**: Start with small data samples
3. **Verify Connections**: Ensure all component connections are valid
4. **Check Component Config**: Verify each component has required parameters
5. **Monitor Processing Rates**: Low rates may indicate bottlenecks

### Environment Management
1. **Use Environment Variables**: Keep pipelines environment-agnostic
2. **Create env.example**: Document required variables for your team
3. **Separate Concerns**: Use different `.env` files per environment
4. **Validate Variables**: Check that all required variables are set before running
5. **Secure Sensitive Data**: Never commit `.env` files with credentials

### Team Collaboration
1. **Version Control Pipelines**: Check `.pipe.json` files into Git
2. **Share Launch Configurations**: Include `.vscode/launch.json` in repo
3. **Document Workflows**: Add README files explaining pipeline purposes
4. **Use Consistent Naming**: Agree on naming conventions for components
5. **Review Pipeline Changes**: Treat pipeline updates like code changes

### Monitoring Production
1. **Keep Status Pages Open**: Monitor long-running pipelines
2. **Set Up Alerts**: Use external monitoring for critical pipelines
3. **Check Logs Regularly**: Review error logs even when pipelines seem fine
4. **Track Metrics Over Time**: Note baseline rates to detect degradation
5. **Have Rollback Plans**: Keep previous working pipeline versions

---

## Troubleshooting

### Connection Issues

#### "Unable to connect to server"
**Causes**:
- Server is not running
- Incorrect host/port configuration
- Firewall blocking connection
- Network issues

**Solutions**:
- Verify the server is running and accessible
- Check Host URL in Settings
- Test connection with `Test Connection` button
- Try connecting from terminal: `curl http://host:port/health`
- Check firewall settings
- For local mode, verify engine path is correct

#### "API key authentication failed"
**Causes**:
- Invalid API key
- API key not set
- API key expired

**Solutions**:
- Open Settings → Connection Settings
- Click "Clear API Key" then "Set API Key"
- Enter a valid API key
- Save settings and reconnect
- Verify API key works with cloud service directly

#### "Connection keeps disconnecting"
**Causes**:
- Network instability
- Server restarts
- Timeout issues

**Solutions**:
- Check network stability
- Verify server health
- Look for server logs indicating restarts
- Check VSCode Output → RocketRide for detailed errors
- Try increasing timeout in settings (if available)

### Pipeline Editor Issues

#### "Visual editor shows blank screen"
**Causes**:
- Webview components not built
- Content Security Policy issue
- Invalid pipeline file

**Solutions**:
- Check if `.pipe.json` file is valid JSON
- Look for errors in VSCode Developer Tools (Help → Toggle Developer Tools)
- Try closing and reopening the file
- Switch to text view to verify file contents
- Check extension logs: View → Output → RocketRide

#### "Changes not saving"
**Causes**:
- File is read-only
- Permission issues
- Extension error

**Solutions**:
- Check file permissions
- Try manual save with Ctrl+S (Cmd+S)
- Check VSCode status bar for errors
- Look at Output → RocketRide for save errors
- Try editing the file as text

#### "Components not appearing in library"
**Causes**:
- Not connected to engine
- Engine doesn't support those components
- Webview loading issue

**Solutions**:
- Ensure you're connected (check status bar)
- Refresh the editor
- Try reconnecting to the engine
- Check if components appear in other pipelines

### Status Monitoring Issues

#### "Status page shows no data"
**Causes**:
- Pipeline not running
- Not connected to engine
- Wrong project/source ID

**Solutions**:
- Verify pipeline is actually running
- Check connection status
- Ensure you opened status for correct component
- Try closing and reopening status page
- Click "Run" to start the pipeline

#### "Graphs not updating"
**Causes**:
- WebSocket connection interrupted
- Browser rendering issue
- No data flowing through pipeline

**Solutions**:
- Check connection status in status bar
- Close and reopen status page
- Verify pipeline is processing data (check item count)
- Look for errors in browser console (Help → Toggle Developer Tools)
- Try reconnecting to engine

#### "High memory usage"
**Causes**:
- Multiple status pages open
- Large pipeline files
- Long-running sessions

**Solutions**:
- Close unused status page tabs
- Restart VSCode periodically
- Monitor VSCode memory usage
- Consider closing and reopening pages for long sessions

### Environment Variable Issues

#### "Variables not being substituted"
**Causes**:
- `.env` file not in workspace root
- Variables don't start with `ROCKETRIDE_`
- Syntax errors in `.env` file

**Solutions**:
- Ensure `.env` is in workspace root directory
- Check all variables start with `ROCKETRIDE_`
- Verify `.env` file syntax (KEY=value format)
- Check Settings → Environment Variables to see loaded vars
- Try reloading VSCode window

#### ".env changes not taking effect"
**Causes**:
- File watcher not detecting changes
- Cached values being used

**Solutions**:
- Save the `.env` file
- Wait a moment for reload
- Check Settings → Environment Variables for updated values
- Try reconnecting to engine
- Reload VSCode window if needed

### Performance Issues

#### "Extension feels slow"
**Causes**:
- Large pipeline files
- Many files in workspace
- Multiple connections
- Memory pressure

**Solutions**:
- Close unused editor tabs
- Disable other extensions temporarily
- Restart VSCode
- Check system resources (CPU/Memory)
- Consider workspace organization (fewer files)

#### "High CPU usage"
**Causes**:
- Active status monitoring
- Multiple pipelines running
- Continuous graph updates

**Solutions**:
- Close unused status pages
- Stop pipelines you're not monitoring
- Reduce graph update frequency (if configurable)
- Check if local engine is consuming CPU
- Monitor other VSCode extensions

---

## Support and Resources

### Getting Help
- **Extension Output**: View → Output → RocketRide (for detailed logs)
- **Developer Tools**: Help → Toggle Developer Tools (for webview issues)
- **GitHub Issues**: Report bugs or request features
- **Documentation**: https://docs.rocketride.ai

### Keyboard Shortcuts

| Action | Windows/Linux | macOS |
|--------|---------------|-------|
| Save Pipeline | Ctrl+S | Cmd+S |
| Command Palette | Ctrl+Shift+P | Cmd+Shift+P |
| Quick Open File | Ctrl+P | Cmd+P |
| Open Settings | Ctrl+, | Cmd+, |
| Refresh Views | Ctrl+R | Cmd+R |

### Useful Commands

Access via Command Palette (Ctrl+Shift+P / Cmd+Shift+P):

- `RocketRide: Open Settings`
- `RocketRide: Connect to Server`
- `RocketRide: Disconnect from Server`
- `RocketRide: Reconnect to Server`
- `RocketRide: Create New Pipeline`
- `RocketRide: Open Status Page`
- `RocketRide: Setup API Key & URL`
- `RocketRide: Refresh All`
- `Developer: Reload Window` (if things get stuck)

---

## What's Next?

Now that you understand how to use the RocketRide extension, you can:

1. **Build Your First Pipeline**: Start with a simple data transformation
2. **Explore Component Types**: Try different readers, transformers, and writers (see [Component Reference](../api/ROCKETRIDE_COMPONENT_REFERENCE.md))
3. **Integrate with Code**: Use the [Python](../api/ROCKETRIDE_python_API.md) or [TypeScript](../api/ROCKETRIDE_typescript_API.md) SDKs
4. **Monitor Production**: Set up real-time monitoring for critical pipelines
5. **Optimize Performance**: Use metrics to identify and fix bottlenecks
6. **Collaborate**: Share pipelines and configurations with your team

Happy pipeline building!

---

*Need help? Check the [SDK & Pipeline Documentation](#sdk--pipeline-documentation) or review [Common Mistakes](../api/ROCKETRIDE_COMMON_MISTAKES.md).*

