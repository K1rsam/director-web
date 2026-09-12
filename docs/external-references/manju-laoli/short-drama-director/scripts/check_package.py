#!/usr/bin/env python3
import os
import sys

def check_skill_package():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    skill_file = os.path.join(base_dir, "SKILL.md")
    refs_dir = os.path.join(base_dir, "references")

    print(f"[+] Checking skill package at: {base_dir}")
    if not os.path.exists(skill_file):
        print("[-] Error: SKILL.md not found!")
        sys.exit(1)
    
    with open(skill_file, "r", encoding="utf-8") as f:
        content = f.read()
        if "name: short-drama-director" not in content:
            print("[-] Error: SKILL.md missing valid frontmatter name!")
            sys.exit(1)

    ref_files = [f for f in os.listdir(refs_dir) if f.endswith(".md")]
    print(f"[+] Found {len(ref_files)} reference rulebooks in references/")
    print("[+] All static checks passed successfully.")

if __name__ == "__main__":
    check_skill_package()
