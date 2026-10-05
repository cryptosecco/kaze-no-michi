import * as THREE from 'three';

// Character look-dev injected into every character material (via material.userData.onBeforeCompile, composed
// by Game.patchMaterial): a warm fresnel rim toward the sun (contre-jour silhouettes) and a soft
// sky/hemisphere fill so dark indigo cloth keeps its colour when seen from the shadow side.
// uSunDir / uSunColor come from the atmosphere chunk (declared under USE_FOG in every fogged material).
//   characterShading(material, { rim, fill, rimTint, trans, rimFade })
//                                    rim/fill multipliers, rimTint 0..1 (albedo tint), trans = thin-cloth
//                                    transmission when backlit, rimFade = [y0, y1]: rest-pose height (m above the
//                                    feet) over which the rim fades in (skinned body meshes only)
//   updateCharacterLighting(game)    per frame: fill colour from the sky + hemisphere

export const CHAR_UNIFORMS = {
  uKzFill: { value: new THREE.Color(0.5, 0.5, 0.6) },
};

export function characterShading(material, { rim = 1, fill = 1, rimTint = 0.5, trans = 0, rimFade = null } = {}) {
  material.userData.shaderKey = 'kz-char' + (trans > 0 ? '-t' : '') + (rimFade ? '-rf' : '');
  const local = {
    uKzRimK: { value: rim },
    uKzFillK: { value: fill },
    uKzRimTint: { value: rimTint },
    uKzTrans: { value: trans },
    uKzRimFade: { value: new THREE.Vector2(...(rimFade || [0, 0])) },
  };
  material.userData.onBeforeCompile = (shader) => {
    shader.uniforms.uKzFill = CHAR_UNIFORMS.uKzFill;
    Object.assign(shader.uniforms, local);
    // legs standing in tall grass get no contre-jour rim: the grass between them and a low sun takes the light.
    // Lit in the rim, the smooth leg tubes of a dark hakama read as two pale sticks along the legs (S1). The
    // bind-pose height (position.y, feet at 0) keeps the fade fixed on the body whatever the pose.
    if (rimFade) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vKzRestY;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvKzRestY = position.y;');
    }
    const rimLow = rimFade ? ' * smoothstep(uKzRimFade.x, uKzRimFade.y, vKzRestY)' : '';
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uKzFill;
uniform float uKzRimK;
uniform float uKzFillK;
uniform float uKzRimTint;
uniform float uKzTrans;
uniform vec2 uKzRimFade;${rimFade ? '\nvarying float vKzRestY;' : ''}`
      )
      .replace(
        '#include <opaque_fragment>',
        `#ifdef USE_FOG
{
  vec3 kzSunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  vec3 kzV = geometryViewDir;
  float kzNV = saturate(dot(normal, kzV));
  float kzFres = pow(1.0 - kzNV, 2.6);
  float kzToward = saturate(dot(normal, kzSunV) * 0.65 + 0.35);
  float kzBack = saturate(-dot(kzV, kzSunV));
  vec3 kzNW = (vec4(normal, 0.0) * viewMatrix).xyz;
  float kzSky = 0.62 + 0.38 * kzNW.y;
  outgoingLight += diffuseColor.rgb * uKzFill * (kzSky * uKzFillK);
  vec3 kzTint = mix(vec3(1.0), diffuseColor.rgb * 2.4 + 0.12, uKzRimTint);
  outgoingLight += uSunColor * kzTint * (kzFres * kzToward * (0.18 + 0.82 * kzBack) * uKzRimK)${rimLow};
  outgoingLight += uSunColor * diffuseColor.rgb * (uKzTrans * pow(kzBack, 3.0) * (0.35 + 0.65 * kzFres));
}
#endif
#include <opaque_fragment>`
      );
  };
  return material;
}

// Fill = hemisphere fill + cool zenith sky (so shaded indigo reads blue, not black).
const _c = new THREE.Color();
export function updateCharacterLighting(game) {
  const L = game.lighting;
  const f = CHAR_UNIFORMS.uKzFill.value;
  if (!L || !L.fill) return;
  f.copy(L.fill.color).multiplyScalar(L.fill.intensity * 1.1);
  const zen = game.sky && game.sky.uniforms && game.sky.uniforms.uSkyZenith ? game.sky.uniforms.uSkyZenith.value : null;
  if (zen) f.add(_c.copy(zen).multiplyScalar(1.3));
}
