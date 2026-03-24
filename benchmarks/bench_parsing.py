#!/usr/bin/env python3
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Multi-format document parsing benchmark.

Compare parsing speed and output quality across parsers:
  - PyPDF2/PyMuPDF (fast, rule-based)
  - pdfplumber (coordinate-based)
  - Built-in Python (text files baseline)

For RocketRide, the engine handles parsing via Tika and native parsers.
This benchmark establishes baselines for the parsing stage.

Usage:
    pip install pymupdf pdfplumber psutil
    python benchmarks/bench_parsing.py <docs_dir> [--pdf-dir <pdf_dir>]
"""

import mimetypes
import os
import sys
import time

import psutil

try:
    import fitz as _fitz
except ImportError:
    _fitz = None

try:
    import pdfplumber as _pdfplumber
except ImportError:
    _pdfplumber = None


def get_mem_mb():
    """Return current process RSS in MB."""
    return psutil.Process().memory_info().rss / (1024 * 1024)


def discover_files(root_dir):
    """Discover all files with type detection."""
    files = {'text': [], 'pdf': [], 'other': []}
    for dirpath, _, filenames in os.walk(root_dir):
        for fname in sorted(filenames):
            fpath = os.path.join(dirpath, fname)
            mime = mimetypes.guess_type(fpath)[0] or ''
            if mime.startswith('text/') or mime in ('application/json', 'application/xml'):
                files['text'].append(fpath)
            elif mime == 'application/pdf' or fname.endswith('.pdf'):
                files['pdf'].append(fpath)
            else:
                files['other'].append(fpath)
    return files


def parse_text_builtin(fpath):
    """Parse text file with built-in Python."""
    with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()


def parse_pdf_pymupdf(fpath):
    """Parse PDF with PyMuPDF (fast, rule-based)."""
    doc = _fitz.open(fpath)
    parts = []
    for page in doc:
        parts.append(page.get_text())
    doc.close()
    return ''.join(parts)


def parse_pdf_pdfplumber(fpath):
    """Parse PDF with pdfplumber (coordinate-based)."""
    parts = []
    with _pdfplumber.open(fpath) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                parts.append(page_text)
    return '\n'.join(parts) + ('\n' if parts else '')


def benchmark_parser(name, parse_func, files):
    """Benchmark a parser on a list of files."""
    if not files:
        return None

    mem_before = get_mem_mb()
    total_chars = 0
    total_files = 0
    errors = 0
    timings = []

    for fpath in files:
        t0 = time.perf_counter()
        try:
            text = parse_func(fpath)
            total_chars += len(text)
            total_files += 1
        except Exception:
            errors += 1
        timings.append(time.perf_counter() - t0)

    total_time = sum(timings)
    mem_after = get_mem_mb()

    return {
        'parser': name,
        'files': total_files,
        'errors': errors,
        'total_chars': total_chars,
        'total_time': total_time,
        'files_per_sec': total_files / total_time if total_time > 0 else 0,
        'mb_per_sec': (total_chars / (1024 * 1024)) / total_time if total_time > 0 else 0,
        'mem_delta_mb': mem_after - mem_before,
    }


def run(root_dir):
    """Run parsing benchmarks on all file types."""
    print('=' * 60)
    print('MULTI-FORMAT PARSING BENCHMARK')
    print(f'Dataset: {root_dir}')
    print('=' * 60)

    files = discover_files(root_dir)
    print(f'\nDiscovered: {len(files["text"])} text, {len(files["pdf"])} PDF, {len(files["other"])} other')

    results = []

    # Text parsing (baseline)
    if files['text']:
        print(f'\n--- Text files ({len(files["text"])}) ---')
        r = benchmark_parser('Python built-in', parse_text_builtin, files['text'])
        if r:
            print(f'  {r["files"]} files, {r["total_chars"]:,} chars in {r["total_time"]:.3f}s')
            print(f'  {r["files_per_sec"]:.0f} files/sec, {r["mb_per_sec"]:.1f} MB/sec')
            results.append(r)

    # PDF parsing
    if files['pdf']:
        print(f'\n--- PDF files ({len(files["pdf"])}) ---')

        # PyMuPDF
        if _fitz is not None:
            r = benchmark_parser('PyMuPDF', parse_pdf_pymupdf, files['pdf'])
            if r:
                print(f'  PyMuPDF: {r["files"]} files, {r["total_chars"]:,} chars in {r["total_time"]:.3f}s')
                print(f'    {r["files_per_sec"]:.0f} files/sec, {r["mb_per_sec"]:.1f} MB/sec')
                results.append(r)
        else:
            print('  PyMuPDF: not installed (pip install pymupdf)')

        # pdfplumber
        if _pdfplumber is not None:
            r = benchmark_parser('pdfplumber', parse_pdf_pdfplumber, files['pdf'])
            if r:
                print(f'  pdfplumber: {r["files"]} files, {r["total_chars"]:,} chars in {r["total_time"]:.3f}s')
                print(f'    {r["files_per_sec"]:.0f} files/sec, {r["mb_per_sec"]:.1f} MB/sec')
                results.append(r)
        else:
            print('  pdfplumber: not installed (pip install pdfplumber)')

    if not results:
        print('\nNo files to benchmark.')
        return {'tool': 'parsing', 'total_time': 0, 'docs': 0, 'chars': 0, 'chunks': 0, 'index_terms': 0, 'mem_delta_mb': 0}

    # Comparison
    print(f'\n{"=" * 60}')
    print('PARSING COMPARISON')
    print(f'{"=" * 60}')
    print(f'{"Parser":<20} {"Files":>8} {"Chars":>12} {"Time":>8} {"files/s":>8} {"MB/s":>8}')
    print('-' * 60)
    for r in results:
        print(f'{r["parser"]:<20} {r["files"]:>8} {r["total_chars"]:>12,} {r["total_time"]:>8.3f} {r["files_per_sec"]:>8.0f} {r["mb_per_sec"]:>8.1f}')

    total_chars = sum(r['total_chars'] for r in results)
    return {
        'tool': 'parsing',
        'total_time': sum(r['total_time'] for r in results),
        'docs': sum(r['files'] for r in results),
        'chars': total_chars,
        'chunks': 0,
        'index_terms': 0,
        'mem_delta_mb': sum(r['mem_delta_mb'] for r in results),
        'parsers': results,
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <docs_directory>')
        sys.exit(1)
    run(sys.argv[1])
