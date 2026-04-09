---
title: 'Drag & Drop'
date: 2025-07-29
---

<head>
  <title>Drag & Drop - RocketRide Documentation</title>
</head>

# **What does it do?**

The Drag & Drop node provides a web-based interface where users can upload files by dragging and dropping them directly into a browser window. It creates a dedicated web page that accepts file uploads and processes them through your pipeline, displaying the results in multiple formats including JSON data, formatted text, tables, and images. This enables easy file processing without requiring command-line tools or complex setup.

## **How do I use it?**

To use the Drag & Drop node in your workflow:

### **Add the Drag & Drop node**

- Insert the node into your pipeline as a source component
- The node automatically creates a web interface accessible via browser

### **Configure Parameters**

- The Drag & Drop node does not have any parameters.

### **Access the Interface**

- Once the pipeline starts, you'll receive a URL to access the drag & drop interface
- Open the provided URL in your web browser
- The interface will show a file upload area where you can drag and drop files

### **Output**

- **Data:** Outputs as Data, needs to be parsed before being sent off in your desired format

### **Upload and Process Files**

- Drag files from your computer directly into the browser window
- Drop them into the designated upload area
- The system will automatically process the files through your pipeline
- Results will be displayed in multiple tabs

### **View Results**

The interface displays results in four different formats:

- **JSON:** Raw structured data from the pipeline
- **Text:** Formatted text output
- **Tables:** Tabular data in markdown format
- **Images:** Processed images and visual outputs

### **Download Results**

Each results tab includes a download button (📥) to save the processed data:

- Download JSON data for further analysis
- Save text output as a file
- Export table data
- Download processed images

## **File Processing**

### **Supported Features**

- **Multiple Files:** Upload several files simultaneously
- **File Uploads**: Supports file upload through the UI (actual size and type limits depend on server and infrastructure configuration)
- **Real-time Processing**: Immediate feedback on upload and processing status
- **Progress Tracking**: Visual indication of processing progress

### **Processing Workflow**

1. **Upload**: Files are uploaded through the web interface
2. **Validation**: System validates file integrity and size
3. **Processing**: Files are sent through your configured pipeline
4. **Results**: Output is displayed in multiple formats
5. **Download**: Users can download results in various formats

## **Example Use Cases**

- **Document Processing**: Upload PDFs, Word documents, or text files for analysis and extraction
- **Image Analysis**: Process images through OCR, classification, or visual analysis pipelines
- **Data Import**: Upload CSV files, spreadsheets, or data files for processing
- **Content Review**: Upload various file types for content moderation or review workflows
- **Batch Processing**: Process multiple files through the same pipeline configuration
- **Quick Testing**: Rapidly test pipeline configurations with different file types
- **Client Access**: Provide easy file upload interface for clients or end users
- **Remote Processing**: Enable file processing without local software installation

## **Interface Features**

### **Upload Area**

- Drag and drop interface for easy file selection
- Support for multiple file uploads
- Visual feedback during upload process
- File size and type validation

### **Results Display**

- **Tabbed Interface**: Organized display of different result formats
- **JSON View**: Raw data for developers and technical users
- **Text View**: Formatted output for easy reading
- **Table View**: Structured data in readable format
- **Image Gallery**: Visual outputs with thumbnail previews

### **Download Options**

- Individual download buttons for each result type
- Automatic file naming based on original upload
- Support for various file formats (JSON, TXT, CSV, images)

## **Troubleshooting**

### **Common Issues**

- **Upload Fails**: Check file size limits and network connectivity
- **File Support:** Ensure the pipeline can handle the file types being uploaded
- **Processing Errors**: Verify pipeline configuration and downstream components
- **Interface Not Loading**: Confirm the URL is correct and the service is running
- **Results Not Displaying**: Check that response components are properly configured

### **Performance Considerations**

- Large files may take longer to upload and process
- Multiple simultaneous uploads may impact performance
- Consider file size limits based on your infrastructure
- Monitor memory usage during file processing

## **In summary**

The Drag & Drop node provides a user-friendly web interface for file upload and processing, making it easy to process files through your pipeline without requiring technical expertise. It displays results in multiple formats and allows downloading of processed data, making it ideal for both technical and non-technical users who need to process files through your pipeline.
