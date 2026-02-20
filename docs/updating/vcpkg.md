# VCPkg updates

VCPkg within the engine is set by the branch identifier and can be updated by:

1. Clone the entire project
2. Run setup
3. Go into the vcpkg directory
4. Use `git checkout master` or `git checkout <commit>` to checkout the latest commit or the particular commit accordingly
5. Use `git pull` to retrieve these changes
6. Go into the root directory
7. Add changes `git add vcpkg`
8. Commit and push changes

Note that there are custom ports that were created, the most complicated on being python3

#
# YOU ARE RESPONSIBLE FOR GOING THROUGH THE CHANGE LOGS OF THE NEW TARGET VERSION AND  DETERMINING IF THERE ARE ANY BREAKING CHANGES!
