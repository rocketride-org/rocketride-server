# frozen_string_literal: true

# RocketRide custom connector for Workato.
# Sends data to a running RocketRide pipeline webhook and returns its answer.
# The connector knows the pipeline lanes explicitly (see the `lanes` pick list)
# and maps each lane to the Content-Type the webhook routes by; the pipeline
# returns the result synchronously in data.objects.<key>.answers.
{
  title: 'RocketRide Connector',

  connection: {
    fields: [
      {
        name: 'webhook_url',
        label: 'Webhook URL',
        optional: false,
        hint: 'Webhook URL of your running RocketRide pipeline, e.g. https://host/webhook'
      },
      {
        name: 'auth_key',
        label: 'Authorization key',
        optional: false,
        control_type: 'password',
        hint: 'Public key (pk_...) or private token from the pipeline Endpoint Configuration'
      }
    ],

    authorization: {
      type: 'custom_auth',
      apply: lambda do |connection|
        headers('Authorization' => "Bearer #{connection['auth_key']}")
      end
    },

    base_uri: lambda do |connection|
      connection['webhook_url']
    end
  },

  # No health endpoint; a minimal text POST validates the URL + auth reach it.
  test: lambda do |_connection|
    post('').headers('Content-Type' => 'text/plain').request_body('ping')
  end,

  pick_lists: {
    # The lanes this connector can talk to (the webhook's _source lanes).
    lanes: lambda do |_connection|
      [
        %w[Question question],
        %w[Text text],
        %w[Image image],
        %w[Audio audio],
        %w[Video video],
        %w[Document document]
      ]
    end
  },

  methods: {
    # Content-Type the webhook routes to each lane (the explicit lane mapping).
    lane_content_type: lambda do |lane, content_type|
      return content_type if content_type.present?

      {
        'text' => 'text/plain',
        'image' => 'image/png',
        'audio' => 'audio/mpeg',
        'video' => 'video/mp4',
        'document' => 'application/pdf'
      }[lane] || 'application/octet-stream'
    end,

    # Pull the pipeline answers out of the webhook response envelope.
    extract_answers: lambda do |response|
      objects = (response.dig('data', 'objects') || {}).values
      answers = objects.flat_map { |o| o.is_a?(Hash) && o['answers'].is_a?(Array) ? o['answers'] : [] }
      { answer: answers.first, answers: answers }
    end,

    # POST a raw body with a given Content-Type and return the parsed answers.
    post_to_lane: lambda do |content_type, body|
      response = post('').headers('Content-Type' => content_type).request_body(body)
      call('extract_answers', response)
    end
  },

  actions: {
    send_to_pipeline: {
      title: 'Send to pipeline',
      subtitle: 'Send data to a chosen RocketRide pipeline lane and get its answer',
      description: "Send to a running <span class='provider'>RocketRide</span> pipeline lane",

      input_fields: lambda do |_object_definitions|
        [
          { name: 'lane', label: 'Lane', control_type: 'select', pick_list: 'lanes', optional: false,
            hint: 'Which pipeline lane to send to, and the data type it accepts:<br>' \
                  '• <b>Question</b> / <b>Text</b> — plain text<br>' \
                  '• <b>Image</b> — image file (image/png, image/jpeg, …)<br>' \
                  '• <b>Audio</b> — audio file (audio/mpeg, audio/wav, …)<br>' \
                  '• <b>Video</b> — video file (video/mp4, …)<br>' \
                  '• <b>Document</b> — document file (application/pdf, …)' },
          { name: 'content', label: 'Content', optional: false,
            hint: 'Plain text for Question/Text; file content (bytes) for Image/Audio/Video/Document.' },
          { name: 'content_type', label: 'Content type', optional: true,
            hint: 'MIME type of the file for media lanes (e.g. image/jpeg, application/pdf). Defaults per lane.' }
        ]
      end,

      execute: lambda do |_connection, input|
        lane = input['lane']
        if lane == 'question'
          question = {
            type: 'question',
            expectJson: false,
            role: '',
            instructions: [], history: [], examples: [], context: [], goals: [], documents: [],
            questions: [{ text: input['content'] }]
          }
          call('post_to_lane', 'application/rocketride-question', question.to_json)
        else
          call('post_to_lane', call('lane_content_type', lane, input['content_type']), input['content'])
        end
      end,

      output_fields: lambda do |_object_definitions|
        [{ name: 'answer', label: 'Answer' }, { name: 'answers', type: 'array', of: 'string' }]
      end
    }
  }
}
