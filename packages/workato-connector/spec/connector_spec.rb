# frozen_string_literal: true

require 'spec_helper'

RSpec.describe 'RocketRide connector' do
  let(:connector) { Workato::Connector::Sdk::Connector.from_file('connector.rb') }

  it 'loads with the right title' do
    expect(connector.title).to eq('RocketRide Connector')
  end

  it 'exposes the send_to_pipeline action' do
    action_names = connector.source['actions'].keys.map(&:to_s)
    expect(action_names).to include('send_to_pipeline')
  end

  it 'declares the supported lanes' do
    lanes = connector.source['pick_lists'][:lanes].call(nil).map(&:last)
    expect(lanes).to include('question', 'text', 'image', 'audio', 'video', 'document')
  end

  it 'declares the connection fields' do
    field_names = connector.source['connection'][:fields].map { |f| f[:name] }
    expect(field_names).to include('webhook_url', 'auth_key')
  end
end
