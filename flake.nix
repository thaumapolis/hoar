{
  description = "Hoar: frost growing on cold glass, one self-contained HTML file";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      # Browser assertions and golden images are painted by one browser process, so a
      # baseline only means identical pixels on the same system. x86_64-linux only.
      systems = [ "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = [
            pkgs.nodejs_22
            pkgs.playwright-driver
            pkgs.git
          ];

          env = {
            # ESM ignores NODE_PATH, so the driver is addressed by absolute path.
            PLAYWRIGHT_ENTRY = "${pkgs.playwright-driver}/index.mjs";
            PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          };

          shellHook = ''
            echo "Hoar: ./check.sh   (build, staleness guard, physics rules, browser artifact checks)"
          '';
        };
      });

      packages = forAllSystems (pkgs: {
        # The artifact alone. Anything other than exactly index.html would mean the
        # bundler had started emitting siblings, breaking the single-file promise.
        default = pkgs.runCommand "hoar"
          {
            src = ./.;
            nativeBuildInputs = [ pkgs.nodejs_22 ];
          }
          ''
            # A Nix source tree is a read-only store path, so the build must write to
            # $out rather than beside src/. $out does not exist when the builder
            # starts -- runCommand only promotes it afterwards -- so it must be created
            # first or Node fails with ENOENT.
            mkdir -p "$out"
            node "$src/tools/build.mjs" "$out/index.html"
            test -s "$out/index.html"

            ! grep -qE '<(script|link|img|source|iframe)[^>]+(src|href)="[^#d]' "$out/index.html" \
              || { echo "artifact references an external file"; exit 1; }

            # A storage or network dependency would throw inside a sandboxed
            # opaque-origin iframe, so the artifact must not ask for one.
            ! grep -qE 'localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(|XMLHttpRequest|WebSocket' "$out/index.html" \
              || { echo "artifact references web storage or the network"; exit 1; }
          '';
      });
    };
}
