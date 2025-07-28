#!/usr/bin/env python3
"""
Script to analyze deduplication effectiveness
"""

import json
import sys
from pathlib import Path
from relaxng_to_codemirror import generate_autocomplete_map

def analyze_deduplication(file_path):
    """Analyze a deduplicated JSON file to show space savings."""
    
    with open(file_path, 'r') as f:
        data = json.load(f)
    
    # Separate references from actual elements
    references = {}
    elements = {}
    
    for key, value in data.items():
        if key.startswith('#'):
            references[key] = value
        else:
            elements[key] = value
    
    print(f"Analysis of {file_path}")
    print("=" * 50)
    print(f"Total elements: {len(elements)}")
    print(f"Total references: {len(references)}")
    
    # Count reference usage
    def count_references(obj, ref_counts):
        if isinstance(obj, str) and obj.startswith('#'):
            ref_counts[obj] = ref_counts.get(obj, 0) + 1
        elif isinstance(obj, dict):
            for v in obj.values():
                count_references(v, ref_counts)
        elif isinstance(obj, list):
            for item in obj:
                count_references(item, ref_counts)
    
    ref_counts = {}
    for element_data in elements.values():
        count_references(element_data, ref_counts)
    
    print(f"\nReference usage:")
    total_references_used = 0
    total_space_saved = 0
    
    for ref_id, count in sorted(ref_counts.items()):
        if ref_id in references:
            ref_size = len(json.dumps(references[ref_id]))
            space_saved = ref_size * (count - 1)  # -1 because we still store it once
            total_space_saved += space_saved
            total_references_used += count
            print(f"  {ref_id}: used {count} times, saves ~{space_saved} chars")
    
    print(f"\nSummary:")
    print(f"  Total reference usages: {total_references_used}")
    print(f"  Estimated space saved: ~{total_space_saved} characters")
    
    # Calculate file sizes
    current_size = len(json.dumps(data, separators=(',', ':')))
    
    # Estimate size without deduplication
    def expand_references(obj):
        if isinstance(obj, str) and obj.startswith('#') and obj in references:
            return expand_references(references[obj])
        elif isinstance(obj, dict):
            return {k: expand_references(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [expand_references(item) for item in obj]
        else:
            return obj
    
    expanded_elements = {k: expand_references(v) for k, v in elements.items()}
    expanded_size = len(json.dumps(expanded_elements, separators=(',', ':')))
    
    print(f"\nFile size comparison:")
    print(f"  With deduplication: {current_size:,} bytes")
    print(f"  Without deduplication: {expanded_size:,} bytes")
    print(f"  Space saved: {expanded_size - current_size:,} bytes ({((expanded_size - current_size) / expanded_size * 100):.1f}%)")
    
    # Show most common reference patterns
    print(f"\nMost referenced patterns:")
    for ref_id, count in sorted(ref_counts.items(), key=lambda x: x[1], reverse=True)[:10]:
        if ref_id in references:
            ref_data = references[ref_id]
            print(f"  {ref_id} (used {count}x): {json.dumps(ref_data)[:100]}...")

def compare_with_without_dedup(rng_file):
    """Generate both versions and compare them."""
    
    print("Generating comparison...")
    
    # Generate without deduplication
    print("  - Without deduplication...")
    normal_map = generate_autocomplete_map(rng_file, deduplicate=False)
    normal_size = len(json.dumps(normal_map, separators=(',', ':')))
    
    # Generate with deduplication
    print("  - With deduplication...")
    dedup_map = generate_autocomplete_map(rng_file, deduplicate=True)
    dedup_size = len(json.dumps(dedup_map, separators=(',', ':')))
    
    print(f"\nComparison:")
    print(f"  Normal version: {normal_size:,} bytes")
    print(f"  Deduplicated version: {dedup_size:,} bytes")
    print(f"  Space saved: {normal_size - dedup_size:,} bytes ({((normal_size - dedup_size) / normal_size * 100):.1f}%)")
    
    # Count elements
    normal_elements = len([k for k in normal_map.keys() if not k.startswith('#')])
    dedup_elements = len([k for k in dedup_map.keys() if not k.startswith('#')])
    dedup_refs = len([k for k in dedup_map.keys() if k.startswith('#')])
    
    print(f"\nStructure:")
    print(f"  Normal: {normal_elements} elements")
    print(f"  Deduplicated: {dedup_elements} elements + {dedup_refs} references")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python analyze_deduplication.py <deduplicated_json_file>")
        print("  python analyze_deduplication.py --compare <rng_file>")
        sys.exit(1)
    
    if sys.argv[1] == '--compare' and len(sys.argv) > 2:
        compare_with_without_dedup(sys.argv[2])
    else:
        analyze_deduplication(sys.argv[1])