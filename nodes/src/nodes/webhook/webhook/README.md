---
title: Webhook
date: 2025-05-18
---

## **What does it do?**

The Webhook node allows you to inject data into your pipeline from any external system or tool that can send HTTP requests. It exposes a RESTful API endpoint that listens for incoming data—such as files, JSON, or form submissions—and triggers your pipeline to process this input automatically. This makes it easy to integrate your pipeline with third-party services, automation tools, or manual uploads, enabling seamless, event-driven workflows.

With the Webhook node, you can:

- Accept files or data from external applications, scripts, or users.
- Trigger pipeline runs from webhooks, API calls, or HTTP clients.
- Integrate with tools like Talend API Tester, Postman, or custom scripts.
- Automate data ingestion and processing from virtually any source.

---

## **Example tutorial**

https://www.youtube.com/watch?v=Gi-frsA2YY0

---

## **How do I use it?**

To use the Webhook node in your workflow:

1. **Add the Webhook node**
   - Place the Webhook node at the start of your pipeline to act as the data source.
2. **Run the Pipeline**
   - Start your pipeline. After it starts, a message will appear in the Project Log with a line like:
   - `Webhook URL: https://...`
3. **Copy the Webhook URL**
   - Copy the link provided after "Webhook URL:".
4. **Send Data to the Webhook**
   - You can use any tool that can send HTTP requests (such as Talend API Tester, Postman, or curl).
   - We recommend the [Talend API Tester Extension](https://chromewebstore.google.com/detail/talend-api-tester-free-ed/aejoelaoggembcahagimdiliamlcdmfm?hl=en) for its simplicity and ease of use.

---

## **Using the Webhook with Talend API Tester**

Step-by-step instructions:

1. **Paste the Webhook URL**
   - In Talend, paste the copied URL into the box under: `SCHEME :// HOST [ ":" PORT ] [ PATH [ "?" QUERY ]]`
2. **Set the HTTP Method**
   - Change the "METHOD" to `POST`.
3. **Add Headers**
   - Under "HEADERS", add two headers:
   - `Content-Type`
   - `Authorization`
   - For Authorization, paste your API key.
   - The API key is provided in the URL under "QUERY PARAMETERS".
   - Make sure the apikey parameter is deselected in the query parameters.
   - You do not need to manually set Content-Type; it will be set automatically based on the file you upload.
4. **Upload Your File**
   - In the "BODY" section, select "File" from the dropdown on the right.
   - Upload your file by dragging it to the checkered box or clicking the "Choose a file..." button.
5. **Send the Request**
   - Click the blue "Send:" button in the top right.
6. **Check the Response**
   - If successful, you'll see a green "200 OK" banner under "Response".
   - If you see a red banner, check for error messages or issues with your file.
7. **Retrieve Your Output**
   - The response will include a JSON file under "BODY".
   - Open the object under `data/objects` in the JSON (e.g., `cce2fa78-f7fb-5a2e-b391-7c896aeda5cf`).
   - Inside this object, open `text` and copy the string inside, that's your pipeline's output.

---

## **Example Use Cases**

- Accepting document uploads from a web form or external app.
- Integrating with automation tools (Zapier, Make, etc.) to trigger pipelines on events.
- Receiving data from IoT devices, monitoring systems, or custom scripts.

---

## **Summary Table of Parameters**

| Parameter     | Description                              | Effect/Usage                             |
| ------------- | ---------------------------------------- | ---------------------------------------- |
| Webhook URL   | The endpoint to send data to             | Triggers the pipeline with uploaded data |
| HTTP Method   | Should be set to POST                    | Required for correct operation           |
| Authorization | API key provided in the URL              | Authenticates the request                |
| Content-Type  | Set automatically based on uploaded file | Ensures correct file handling            |
| Body (File)   | The file or data to upload               | Input for the pipeline                   |

---

**In summary:**

The Webhook node lets you trigger your pipeline from any external system or tool by sending an HTTP request, making it easy to automate and integrate your data workflows.
