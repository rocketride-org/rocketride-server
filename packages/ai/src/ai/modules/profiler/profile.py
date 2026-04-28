"""
WebServer Profiler Implementation.

This module contains the WebServerProfiler class that provides
comprehensive profiling capabilities for web applications.
"""

import time
import cProfile
import pstats
import io
from typing import Dict, Any, List, Optional


class WebServerProfiler:
    """
    Integrated profiler for web servers.

    Provides HTTP endpoints for controlling profiling and viewing results.
    No file creation - all results available via HTTP endpoints.
    """

    def __init__(self):
        """
        Define the initialization.
        """
        self.profiler: Optional[cProfile.Profile] = None
        self.start_time: Optional[float] = None
        self.session_name: Optional[str] = None
        self.profiles_history: List[Dict[str, Any]] = []
        self.current_profile_data: Optional[str] = None

    def is_profiling(self) -> bool:
        """Check if profiling is currently active."""
        return self.profiler is not None

    def start_profiling(self, session_name: str = None) -> Dict[str, Any]:
        """Start a profiling session."""
        if self.profiler is not None:
            return {'error': 'Profiling is already active', 'status': 'error', 'current_session': self.session_name}

        self.session_name = session_name or f'session_{int(time.time())}'
        self.profiler = cProfile.Profile()
        self.start_time = time.time()

        self.profiler.enable()

        return {
            'message': f'Started profiling session: {self.session_name}',
            'status': 'started',
            'session': self.session_name,
            'start_time': self.start_time,
        }

    def stop_profiling(self) -> Dict[str, Any]:
        """Stop the current profiling session and generate report."""
        if self.profiler is None:
            return {'error': 'No active profiling session', 'status': 'error'}

        # Stop profiling
        self.profiler.disable()
        end_time = time.time()
        runtime = end_time - self.start_time

        # Generate comprehensive report in memory
        full_report = io.StringIO()
        full_report.write('RocketRide Profile Report\n')
        full_report.write(f'Session: {self.session_name}\n')
        full_report.write(f'Start Time: {time.ctime(self.start_time)}\n')
        full_report.write(f'End Time: {time.ctime(end_time)}\n')
        full_report.write(f'Runtime: {runtime:.2f} seconds\n')
        full_report.write('=' * 80 + '\n\n')

        # Functions sorted by cumulative time
        s = io.StringIO()
        stats = pstats.Stats(self.profiler, stream=s)
        stats.sort_stats('cumulative')

        # Capture full stats
        stats.print_stats()
        full_report.write('ALL FUNCTIONS BY CUMULATIVE TIME:\n')
        full_report.write('-' * 50 + '\n')
        full_report.write(s.getvalue())
        full_report.write('\n\n')
        s.truncate(0)

        # Functions sorted by total time
        stats.sort_stats('tottime')
        stats.print_stats(30)  # Top 30
        full_report.write('TOP 30 FUNCTIONS BY TOTAL TIME:\n')
        full_report.write('-' * 50 + '\n')
        full_report.write(s.getvalue())
        s.truncate(0)

        # Store the complete report
        self.current_profile_data = full_report.getvalue()

        # Generate summary for API response (top 15 functions)
        s = io.StringIO()
        stats = pstats.Stats(self.profiler, stream=s)
        stats.sort_stats('cumulative')
        stats.print_stats(15)  # Top 15 for API response
        top_functions = s.getvalue()
        s.truncate(0)

        # Store in history
        profile_record = {
            'session': self.session_name,
            'start_time': self.start_time,
            'end_time': end_time,
            'runtime': runtime,
            'timestamp': int(time.time()),
            'summary': top_functions,
        }
        self.profiles_history.append(profile_record)

        # Keep only last 10 profiles in history
        if len(self.profiles_history) > 10:
            self.profiles_history = self.profiles_history[-10:]

        # Reset profiler state
        session_name = self.session_name
        self.profiler = None
        self.start_time = None
        self.session_name = None

        return {
            'message': f"Profiling session '{session_name}' completed",
            'status': 'completed',
            'session': session_name,
            'runtime': runtime,
            'top_functions': top_functions.split('\n')[:20],  # First 20 lines
            'profile_record': profile_record,
        }

    def get_status(self) -> Dict[str, Any]:
        """Get current profiling status."""
        if self.profiler is None:
            return {
                'status': 'inactive',
                'message': 'No active profiling session',
                'history_count': len(self.profiles_history),
                'last_profiles': self.profiles_history[-5:] if self.profiles_history else [],
            }
        else:
            current_runtime = time.time() - self.start_time if self.start_time else 0
            return {
                'status': 'active',
                'session': self.session_name,
                'start_time': self.start_time,
                'runtime': current_runtime,
                'message': f"Profiling session '{self.session_name}' active for {current_runtime:.1f}s",
            }

    def get_full_report(self) -> str:
        """Get the complete profiling report from the last session."""
        if self.current_profile_data is None:
            return 'No profiling data available. Run a profiling session first.'
        return self.current_profile_data

    def generate_html_dashboard(self) -> str:
        """Generate an HTML report showing profiling status and history."""
        current_status = self.get_status()

        html = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <title>RocketRide Profiler Dashboard</title>
            <style>
                body {{ font-family: Arial, sans-serif; margin: 20px; background-color: #f5f5f5; }}
                .container {{ max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }}
                .header {{ background: #2c3e50; color: white; padding: 20px; margin: -20px -20px 20px -20px; border-radius: 8px 8px 0 0; }}
                .status {{ padding: 15px; margin: 10px 0; border-radius: 5px; }}
                .status.active {{ background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }}
                .status.inactive {{ background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }}
                .controls {{ margin: 20px 0; }}
                .btn {{ padding: 10px 20px; margin: 5px; border: none; border-radius: 4px; cursor: pointer; text-decoration: none; display: inline-block; }}
                .btn.start {{ background: #28a745; color: white; }}
                .btn.stop {{ background: #dc3545; color: white; }}
                .btn.refresh {{ background: #17a2b8; color: white; }}
                .history {{ margin-top: 30px; }}
                .profile-item {{ background: #f8f9fa; border: 1px solid #dee2e6; margin: 10px 0; padding: 15px; border-radius: 5px; }}
                .profile-item h4 {{ margin: 0 0 10px 0; color: #495057; }}
                .profile-details {{ font-size: 0.9em; color: #6c757d; }}
                .download-link {{ color: #007bff; text-decoration: none; margin-right: 15px; }}
                .download-link:hover {{ text-decoration: underline; }}
                table {{ width: 100%; border-collapse: collapse; margin-top: 15px; }}
                th, td {{ padding: 8px 12px; text-align: left; border-bottom: 1px solid #dee2e6; }}
                th {{ background-color: #f8f9fa; font-weight: bold; }}
                .runtime {{ font-weight: bold; }}
                pre {{ background: #f8f9fa; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 0.85em; }}
            </style>
            <script>
                function startProfiling() {{
                    const sessionName = document.getElementById('sessionName').value || 'web_session';
                    fetch('/profile/start?session=' + sessionName, {{method: 'POST'}})
                        .then(response => response.json())
                        .then(data => {{
                            alert(data.message || 'Profiling started');
                            location.reload();
                        }})
                        .catch(error => alert('Error: ' + error));
                }}

                function stopProfiling() {{
                    fetch('/profile/stop', {{method: 'POST'}})
                        .then(response => response.json())
                        .then(data => {{
                            alert(data.message || 'Profiling stopped');
                            location.reload();
                        }})
                        .catch(error => alert('Error: ' + error));
                }}

                function refreshPage() {{
                    location.reload();
                }}

                // Auto-refresh every 10 seconds if profiling is active
                {'setInterval(refreshPage, 10000);' if current_status['status'] == 'active' else ''}
            </script>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🔍 RocketRide Profiler Dashboard</h1>
                    <p>Monitor and control profiling sessions for performance analysis</p>
                </div>

                <div class="status {current_status['status']}">
                    <h3>Current Status: {current_status['status'].upper()}</h3>
                    <p>{current_status['message']}</p>
        """

        if current_status['status'] == 'active':
            html += f"""
                    <p><strong>Session:</strong> {current_status['session']}</p>
                    <p><strong>Runtime:</strong> <span class="runtime">{current_status['runtime']:.1f} seconds</span></p>
                    <p><strong>Started:</strong> {time.ctime(current_status['start_time'])}</p>
            """

        html += f"""
                </div>

                <div class="controls">
                    <h3>Controls</h3>
                    <input type="text" id="sessionName" placeholder="Session name (optional)" style="padding: 10px; margin: 5px; border: 1px solid #ccc; border-radius: 4px;">
                    <button class="btn start" onclick="startProfiling()" {'disabled' if current_status['status'] == 'active' else ''}>
                        🚀 Start Profiling
                    </button>
                    <button class="btn stop" onclick="stopProfiling()" {'disabled' if current_status['status'] == 'inactive' else ''}>
                        🛑 Stop Profiling
                    </button>
                    <button class="btn refresh" onclick="refreshPage()">
                        🔄 Refresh
                    </button>
                </div>

                <div class="history">
                    <h3>📊 Profile History ({len(self.profiles_history)} sessions)</h3>
        """

        if not self.profiles_history:
            html += '<p>No profiling sessions recorded yet.</p>'
        else:
            html += """
                    <table>
                        <thead>
                            <tr>
                                <th>Session</th>
                                <th>Date</th>
                                <th>Runtime</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
            """

            # Show most recent profiles first
            for profile in reversed(self.profiles_history[-10:]):  # Last 10 profiles
                # Use session name as identifier for reports since we store data in memory
                session_id = profile['session']
                html += f"""
                        <tr>
                            <td><strong>{profile['session']}</strong></td>
                            <td>{time.ctime(profile['start_time'])}</td>
                            <td class="runtime">{profile['runtime']:.2f}s</td>
                            <td>
                                <a href="/profile/report?session={session_id}" class="download-link" target="_blank">📄 View Report</a>
                            </td>
                        </tr>
                """

            html += """
                        </tbody>
                    </table>
            """

        html += """
                </div>

                <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #dee2e6; color: #6c757d; font-size: 0.9em;">
                    <h4>🛠️ API Endpoints:</h4>
                    <ul>
                        <li><strong>PUT /profile/start?session=name</strong> - Start profiling</li>
                        <li><strong>PUT /profile/stop</strong> - Stop profiling</li>
                        <li><strong>GET /profile</strong> - View this dashboard</li>
                        <li><strong>GET /profile/report?session=name</strong> - Get full report</li>
                    </ul>

                    <h4>💡 Usage Tips:</h4>
                    <ul>
                        <li>Start profiling before running your performance test</li>
                        <li>Let your test complete, then stop profiling</li>
                        <li>View the report to analyze bottlenecks</li>
                        <li>Reports are stored in memory and available via HTTP endpoints</li>
                    </ul>
                </div>
            </div>
        </body>
        </html>
        """

        return html
