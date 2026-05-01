// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const BASE_RADIUS        = 6000;   // reference; actual per-planet radius varies
const MAX_LOD_LEVEL      = 10;
const CHUNK_SEGMENTS     = 32;
const NUM_PLANETS        = 200;
const GALAXY_RADIUS      = 20_000_000;
const MIN_SPACING        = 500_000;
const TRANSITION_SPEED   = 0.018;

// ─── RNG ──────────────────────────────────────────────────────────────────────
function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = Math.imul(31, h) + s.charCodeAt(i) | 0; }
    return h;
}
function makeRng(seed) {
    let s = Math.abs(seed) | 1;
    return () => { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}
function smoothstep01(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

// ─── SNOISE GLSL CHUNK ────────────────────────────────────────────────────────
const SNOISE = `
vec3 _m289v3(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 _m289v4(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 _perm(vec4 x){return _m289v4(((x*34.)+1.)*x);}
vec4 _tis(vec4 r){return 1.79284291400159-.85373472095314*r;}
float snoise(vec3 v){
    const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);
    vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
    vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;
    vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
    vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
    i=_m289v3(i);
    vec4 p=_perm(_perm(_perm(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
    float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;
    vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
    vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);
    vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
    vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));
    vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
    vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);
    vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
    vec4 norm=_tis(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
    p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
    vec4 m=max(.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m*=m;
    return 105.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

// ─── CORE PROCEDURAL MATH (terrain + erosion) ─────────────────────────────────
const CORE_MATH = `
${SNOISE}
uniform vec3  u_seedOffset;
uniform float u_terrainMode;
uniform float u_terrainParam;
uniform float u_terrainParam2;

vec3 _h33(vec3 p){
    p=vec3(dot(p,vec3(127.1,311.7,74.7)),dot(p,vec3(269.5,183.3,246.1)),dot(p,vec3(113.5,271.9,124.6)));
    return fract(sin(p)*43758.5453123);
}
vec2 voronoi(vec3 x){
    x+=u_seedOffset;vec3 p=floor(x);vec3 f=fract(x);vec2 res=vec2(100.);
    for(int k=-1;k<=1;k++)for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){
        vec3 b=vec3(float(i),float(j),float(k));
        vec3 r=b-f+_h33(p+b);float d=dot(r,r);
        if(d<res.x){res.y=res.x;res.x=d;}else if(d<res.y){res.y=d;}
    }
    return sqrt(res);
}
float fbm2(vec3 x){x+=u_seedOffset;float v=0.;float a=.5;vec3 s=vec3(100.);
    for(int i=0;i<2;++i){v+=a*snoise(x);x=x*2.+s;a*=.5;}return v;}
float fbm4(vec3 x){x+=u_seedOffset;float v=0.;float a=.5;vec3 s=vec3(100.);
    for(int i=0;i<4;++i){v+=a*snoise(x);x=x*2.+s;a*=.5;}return v;}
float fbm8(vec3 x){x+=u_seedOffset;float v=0.;float a=.5;vec3 s=vec3(100.);
    for(int i=0;i<8;++i){v+=a*snoise(x);x=x*2.+s;a*=.5;}return v;}
float fbmRidged(vec3 x){x+=u_seedOffset;float v=0.;float a=.5;vec3 s=vec3(100.);
    for(int i=0;i<6;++i){float n=1.-abs(snoise(x));v+=a*n*n;x=x*2.+s;a*=.5;}return v;}

// ── Erosion: gradient-aligned gully stripes in Worley cells ──
// Based on technique by Clay John / Fewes (frequency approach).
// Gradient computed numerically on the sphere surface.
float erosionOctave(vec3 n, float cellScale) {
    // Tangent frame
    vec3 ta = abs(n.y) < 0.99 ? normalize(cross(n, vec3(0.,1.,0.)))
                               : normalize(cross(n, vec3(1.,0.,0.)));
    vec3 bi = cross(ta, n);

    // Numerical gradient of 2-octave noise along tangent directions
    float eps = 0.005;
    float gta = fbm2((n + ta*eps)*4.) - fbm2((n - ta*eps)*4.);
    float gbi = fbm2((n + bi*eps)*4.) - fbm2((n - bi*eps)*4.);
    vec3 gradW = gta*ta + gbi*bi;
    float slope = length(gradW);

    // Flat terrain: return ridge value so peaks are preserved (frequency approach)
    if (slope < 0.0005) return 1.0;

    // Direction perpendicular to gradient on sphere surface = gully direction
    vec3 gullyDir = normalize(cross(gradW, n));

    // Worley cells (8-corner cube)
    vec3 pp = n * cellScale + u_seedOffset * 0.7;
    vec3 pi = floor(pp); vec3 pf = fract(pp);

    float cS = 0., sS = 0., wS = 0.;
    for (int k=0; k<=1; k++)
    for (int j=0; j<=1; j++)
    for (int i=0; i<=1; i++) {
        vec3 cell = pi + vec3(float(i),float(j),float(k));
        vec3 piv  = _h33(cell);
        vec3 diff = pf - piv - vec3(float(i),float(j),float(k));
        float d2  = dot(diff,diff);
        float w   = max(0., 1. - d2*4.); w *= w;
        if (w < 0.0001) continue;

        // Per-cell rotation of gully direction → branching variety
        float angle = (_h33(cell + 3.7).z - 0.5) * 1.8;
        float ca = cos(angle), sa = sin(angle);
        vec3 rGully = ca*gullyDir + sa*normalize(cross(gullyDir, n));

        // Stripe frequency scales with slope (frequency approach: flat→thick→ridge)
        float freq = (slope * 10. + 1.5) * 6.2832;
        float t = dot(diff, rGully) * freq;

        cS += w*cos(t); sS += w*sin(t); wS += w;
    }
    cS /= max(wS, .001); sS /= max(wS, .001);

    // Partial normalization k=2 (avoids spiky protrusions, per article)
    float len = sqrt(cS*cS + sS*sS);
    if (len > 0.5) { cS /= len; } else { cS *= 2.; }

    // Frequency approach: near-flat terrain → preserve ridge (1.0)
    return mix(1., cS*.5+.5, smoothstep(0., 0.06, slope));
}

float craterField(vec3 pos, float scale, float rimH, float floorD) {
    vec3 sp = pos * scale + u_seedOffset * 1.3;
    vec2 v = voronoi(sp);
    float d = v.x;
    float bnd = v.y - v.x;
    // bowl interior
    float bowl = smoothstep(0.0, 0.55, d) * (-floorD);
    // raised rim
    float rim  = (1.0 - abs(d - 0.55) / 0.18) * rimH * smoothstep(0.0, 0.12, bnd);
    rim = max(rim, 0.0);
    // small central peak
    float peak = (1.0 - smoothstep(0.0, 0.12, d)) * rimH * 0.4;
    // ejecta blanket
    float ejecta = snoise(pos * scale * 3.0 + u_seedOffset) * 0.04
                 * smoothstep(0.55, 1.0, d) * smoothstep(1.4, 0.6, d);
    return bowl + rim + peak + ejecta;
}

float lavaChannels(vec3 pos, float scale, float depth) {
    // Domain warp then voronoi edges become lava troughs
    vec3 w = vec3(fbm2(pos*scale*0.7+10.), fbm2(pos*scale*0.7+20.), fbm2(pos*scale*0.7+30.));
    vec3 wp = pos * scale + w * 0.5 + u_seedOffset;
    vec2 v = voronoi(wp);
    float edge = v.y - v.x;
    // troughs at cell edges
    float trough = (1.0 - smoothstep(0.0, 0.12, edge)) * (-depth);
    return trough;
}

float terraceElevation(float raw, float steps, float sharpness) {
    float s = raw * steps;
    float floor_ = floor(s);
    float frac_ = s - floor_;
    // sigmoid quantize
    float sig = 1.0 / (1.0 + exp(-(frac_ - 0.5) * sharpness * 10.0));
    return (floor_ + sig) / steps;
}

float duneField(vec3 pos, float scale, float height) {
    // Wind direction derived from seed
    float wx = sin(u_seedOffset.x * 3.7 + 1.1);
    float wz = cos(u_seedOffset.z * 2.9 + 0.7);
    vec3 wind = normalize(vec3(wx, 0.0, wz));
    float proj = dot(pos, wind);
    // modulate dune amplitude with FBM
    float amp = fbm2(pos * 1.8 + u_seedOffset * 0.5) * 0.5 + 0.5;
    float dune = sin(proj * scale * 6.2832) * 0.5 + 0.5;
    return dune * amp * height;
}

float crystalSpires(vec3 pos, float scale, float height) {
    vec3 sp = pos * scale + u_seedOffset * 0.9;
    vec2 v = voronoi(sp);
    float d = v.x;
    float bnd = v.y - v.x;
    // sharp spike at cell center
    float spike = pow(max(1.0 - d / 0.5, 0.0), 3.0) * height;
    // edge ridges
    float ridge = (1.0 - smoothstep(0.0, 0.06, bnd)) * height * 0.4;
    return spike + ridge;
}

float _rawStandard(vec3 pos) {
    vec3 w = vec3(fbm4(pos*2.), fbm4(pos*2.+10.), fbm4(pos*2.+20.));
    vec3 wp = pos + w*0.4;
    vec2 vP = voronoi(wp*1.5); float pBnd = vP.y-vP.x;
    float bc = snoise((wp*1.)+u_seedOffset)*.5+.5;
    bc = mix(bc, vP.x, 0.4);
    float lm = smoothstep(0.42, 0.52, bc);
    float mm = (1.-smoothstep(0.,0.15,pBnd))*smoothstep(0.3,0.6,bc)*smoothstep(-0.2,0.5,snoise((wp*4.)+u_seedOffset));
    float peaks = fbmRidged(wp*4.)*.6;
    vec2 vC = voronoi(wp*6.); float cBnd = vC.y-vC.x;
    float cm = (1.-smoothstep(0.,0.03,cBnd))*lm*(1.-mm);
    float plains = fbm8(wp*5.)*.03;
    return bc*.12 + lm*.05 + plains*lm + mm*peaks - cm*.08;
}

float getRawElevation(vec3 pos) {
    float base = _rawStandard(pos);
    if (u_terrainMode < 0.5) return base;
    if (u_terrainMode < 1.5) {
        // craters
        return base * 0.3 + craterField(pos, u_terrainParam, 0.18, 0.12) + u_terrainParam2 * 0.05;
    }
    if (u_terrainMode < 2.5) {
        // lava channels
        return base + lavaChannels(pos, u_terrainParam, u_terrainParam2);
    }
    if (u_terrainMode < 3.5) {
        // terraces
        return terraceElevation(base, u_terrainParam, u_terrainParam2);
    }
    if (u_terrainMode < 4.5) {
        // dunes
        return base * 0.2 + duneField(pos, u_terrainParam, u_terrainParam2);
    }
    // spires (mode 5)
    return base * 0.4 + crystalSpires(pos, u_terrainParam, u_terrainParam2);
}

float getSurfaceElevation(vec3 pos){ return max(getRawElevation(pos), 0.08); }
`;

// ─── ATMOSPHERE SHADERS ───────────────────────────────────────────────────────
const ATMOS_VERT = `
varying vec3 vNormal; varying vec3 vPosWorld;
void main(){
    vNormal=normalize(normalMatrix*normal);
    vec4 wp=modelMatrix*vec4(position,1.); vPosWorld=wp.xyz;
    gl_Position=projectionMatrix*viewMatrix*wp;
}`;

const ATMOS_FRAG = `
varying vec3 vNormal; varying vec3 vPosWorld;
uniform vec3 u_sunDir; uniform float u_radius;
uniform vec3 u_planetCenter;
uniform vec3 u_atmosZenith; uniform vec3 u_atmosHorizon;
uniform float u_atmosOpacity;
void main(){
    vec3 vd=normalize(vPosWorld-cameraPosition);
    vec3 pn=normalize(vPosWorld-u_planetCenter);
    float sun=dot(pn,u_sunDir);
    float dayMix=smoothstep(-0.2,0.2,sun);
    vec3 horiz=mix(u_atmosHorizon*vec3(1.5,.6,.2), u_atmosHorizon, smoothstep(-0.1,0.3,sun));
    float optD=pow(1.-abs(dot(vd,pn)),4.);
    vec3 ac=mix(u_atmosZenith,horiz,optD);
    ac+=vec3(1.,.9,.7)*pow(max(dot(vd,u_sunDir),0.),20.)*dayMix;
    float camAlt=max(length(cameraPosition-u_planetCenter)-u_radius,0.);
    float gr=1.-clamp(camAlt/(u_radius*.25),0.,1.);
    float alpha=(max(optD,gr*.9)*dayMix + optD*.1*(1.-dayMix)) * u_atmosOpacity;
    gl_FragColor=vec4(ac,alpha);
}`;

// ─── CLOUD SHADERS ────────────────────────────────────────────────────────────
const CLOUD_VERT = `varying vec3 vSP;
void main(){ vSP=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;

const CLOUD_FRAG = `
${SNOISE}
uniform vec3 u_seedOffset; uniform vec3 u_sunDir; uniform float u_cloudDensity;
varying vec3 vSP;
void main(){
    vec3 p=vSP*3.2+u_seedOffset*.5;
    float n=snoise(p)*.50+snoise(p*2.1+vec3(1.7,9.2,0.))*.25
           +snoise(p*4.4+vec3(8.3,2.8,0.))*.13+snoise(p*8.8+vec3(5.1,6.4,0.))*.06;
    n=n*.5+.5;
    float thr=u_cloudDensity;
    float cloud=smoothstep(thr,thr+.18,n);
    float fringe=smoothstep(thr-.06,thr,n)*(1.-cloud);
    float light=mix(.55,1.,max(dot(vSP,u_sunDir),0.));
    gl_FragColor=vec4(vec3(light*.94,light*.96,light),cloud*.88+fringe*.25);
}`;

// ─── PLANET TERRAIN VERTEX SHADER ─────────────────────────────────────────────
const VERT = `
${CORE_MATH}
uniform vec3 u_center; uniform vec3 u_axisA; uniform vec3 u_axisB;
uniform float u_radius; uniform vec3 u_planetCenter;
uniform float u_waterLevel; uniform float u_erosionStr;
varying vec2 vClimate; varying float vElevation;
varying vec3 vWorldPosition; varying vec3 vLocalPos; varying vec3 vPlanetNormal;
varying vec3 vNormal;
varying float vRockVar; varying float vGroundVar;

void main(){
    vec3 sp = normalize(u_center + u_axisA*position.x + u_axisB*position.y);
    float raw = getRawElevation(sp);

    // Erosion: two octaves of gradient-aligned gully displacement
    float g1 = erosionOctave(sp, 5.5);
    float g2 = erosionOctave(sp, 11.5);
    float gully = g1*.65 + g2*.35;
    float erodeMask = smoothstep(u_waterLevel, u_waterLevel+.04, raw);
    float erodedElev = raw + (gully-.5)*.05 * erodeMask * u_erosionStr;

    vElevation = erodedElev;
    vPlanetNormal = sp;

    float moisture=(fbm2(sp*3.+50.)+1.)*.5;
    float temp=clamp((1.-abs(sp.y))+fbm2(sp*4.)*.2-max(erodedElev,.0)*.8, 0., 1.);
    vClimate=vec2(moisture,temp);
    vRockVar=fbm2(sp*14.+vec3(30.,17.,55.))*.5+.5;
    vGroundVar=fbm2(sp*6.+vec3(70.,90.,10.))*.5+.5;

    float physElev = max(erodedElev, u_waterLevel);
    vec3 localPos = sp*(u_radius + physElev*u_radius*0.08);

    // Smooth vertex normal: sample terrain at two neighbouring sphere points so
    // interpolated normals eliminate the flat-shaded facet look in walk mode.
    float nEps = 0.004;
    vec3 tanA = normalize(u_axisA);
    vec3 tanB = normalize(u_axisB);
    float hA = max(getRawElevation(normalize(sp + tanA * nEps)), u_waterLevel);
    float hB = max(getRawElevation(normalize(sp + tanB * nEps)), u_waterLevel);
    vec3 pA = normalize(sp + tanA * nEps) * (u_radius + hA * u_radius * 0.08) - localPos;
    vec3 pB = normalize(sp + tanB * nEps) * (u_radius + hB * u_radius * 0.08) - localPos;
    vNormal = normalize(cross(pA, pB));

    vLocalPos = localPos;
    vWorldPosition = localPos + u_planetCenter;
    gl_Position = projectionMatrix*viewMatrix*vec4(vWorldPosition,1.);
}`;

// ─── PLANET TERRAIN FRAGMENT SHADER ───────────────────────────────────────────
const FRAG = `
${SNOISE}
varying vec2 vClimate; varying float vElevation;
varying vec3 vWorldPosition; varying vec3 vLocalPos; varying vec3 vPlanetNormal;
varying vec3 vNormal;
varying float vRockVar; varying float vGroundVar;
uniform vec3 u_sunDir; uniform float u_radius; uniform vec3 u_planetCenter;
uniform float u_waterLevel;
uniform vec3 u_deepWater; uniform vec3 u_shallowWater; uniform vec3 u_coast;
uniform vec3 u_lowland;  uniform vec3 u_midland;     uniform vec3 u_highland;
uniform vec3 u_snowColor; uniform vec3 u_rockColor;
uniform float u_snowLine;
uniform vec3 u_atmosZenith; uniform vec3 u_atmosHorizon;
uniform float u_atmosOpacity;
uniform float u_colorMode;
uniform vec3  u_emissiveColor;
uniform float u_emissiveStr;
uniform vec3  u_seedOffset;

void main(){
    float gv = vGroundVar;

    // Biome colours — blended by moisture × temperature
    vec3 hotColor  = mix(mix(u_lowland, u_midland,  smoothstep(.25,.55,vClimate.x)),
                         u_midland,                  smoothstep(.50,.75,vClimate.x));
    vec3 coldColor = mix(u_midland, u_highland, smoothstep(.40,.65,vClimate.x));
    // Apply ground micro-variation
    hotColor  = mix(hotColor,  hotColor  * vec3(.88,.92,.88) + .05, gv*.4);
    coldColor = mix(coldColor, coldColor * vec3(.92,.95,.90) + .04, gv*.35);

    vec3 landColor = mix(u_snowColor, u_highland, smoothstep(.10,.28,vClimate.y));
    landColor = mix(landColor, coldColor,  smoothstep(.28,.50,vClimate.y));
    landColor = mix(landColor, hotColor,   smoothstep(.55,.75,vClimate.y));

    // Color mode overrides
    if (u_colorMode > 0.5 && u_colorMode < 1.5) {
        // molten: low elev = hot orange/red glow, high = dark rock
        float heat = 1.0 - smoothstep(0.0, 0.18, vElevation);
        landColor = mix(landColor, vec3(1.0, 0.3, 0.0), heat * 0.85);
    } else if (u_colorMode > 1.5 && u_colorMode < 2.5) {
        // ice: shift everything toward blue-white
        landColor = mix(landColor, vec3(0.75, 0.88, 1.0), 0.55);
    } else if (u_colorMode > 2.5 && u_colorMode < 3.5) {
        // desert: warm tint
        landColor = mix(landColor, vec3(0.85, 0.65, 0.30), 0.45);
    } else if (u_colorMode > 3.5 && u_colorMode < 4.5) {
        // alien: hue shift toward purple/teal
        float hShift = snoise(vPlanetNormal * 3.0 + u_seedOffset) * 0.5 + 0.5;
        vec3 alienTint = mix(vec3(0.55, 0.1, 0.8), vec3(0.0, 0.7, 0.6), hShift);
        landColor = mix(landColor, alienTint, 0.6);
    } else if (u_colorMode > 4.5) {
        // bioluminescent: dark base, emissive patches via noise
        float bio = snoise(vPlanetNormal * 6.0 + u_seedOffset) * 0.5 + 0.5;
        float bioPatch = smoothstep(0.55, 0.75, bio);
        landColor = mix(vec3(0.02, 0.04, 0.06), landColor * 0.3, 0.7);
        landColor += u_emissiveColor * bioPatch * 0.8;
    }

    // Smooth interpolated vertex normal (computed in VERT from terrain gradient)
    vec3 normal = normalize(vNormal);
    float slope = 1.-dot(normal, vPlanetNormal);

    // Rock on steep faces — colour varies by climate (warm rock in hot zones)
    vec3 rockC = mix(u_rockColor, u_rockColor*1.3+vec3(.05,.03,0.), vRockVar);
    rockC = mix(rockC, rockC*vec3(1.3,1.1,.9), smoothstep(.5,.9,vClimate.y)*.5);
    float rockBlend = smoothstep(.10,.32,slope);
    landColor = mix(landColor, rockC, rockBlend);

    // Snow — two-stage: grey-rock pre-snow then white
    float preSnow = smoothstep(u_snowLine-.08,u_snowLine-.01,vElevation)*(1.-rockBlend);
    landColor = mix(landColor, mix(rockC, u_snowColor,.4), preSnow);
    landColor = mix(landColor, u_snowColor, smoothstep(u_snowLine, u_snowLine+.12, vElevation));

    // Water
    vec3 waterC = mix(u_deepWater, u_shallowWater, smoothstep(.03, u_waterLevel, vElevation));
    vec3 coastC = mix(u_coast, landColor, smoothstep(u_waterLevel, u_waterLevel+.012, vElevation));
    vec3 finalColor = mix(waterC, coastC, smoothstep(u_waterLevel-.001, u_waterLevel+.001, vElevation));

    // Lighting
    float diffuse = max(dot(vElevation<u_waterLevel-.005 ? vPlanetNormal : normal, u_sunDir), 0.);
    if(vElevation<=u_waterLevel+.001){
        vec3 vd=normalize(cameraPosition-vWorldPosition);
        float spec=pow(max(dot(normal,normalize(u_sunDir+vd)),0.),128.)*1.5;
        diffuse+=spec;
    }
    vec3 vdr=cameraPosition-vWorldPosition; float vdist=length(vdr);
    vec3 nv=vdist>.0001?vdr/vdist:vPlanetNormal;
    float headlamp=max(dot(normal,nv),0.)*.15;
    vec3 litColor=finalColor*(diffuse+.18+headlamp);
    litColor += u_emissiveColor * u_emissiveStr * (vElevation < u_waterLevel + 0.05 ? 1.0 : 0.0);

    // Atmospheric fog — zenith/horizon from planet type
    float sunLight=dot(vPlanetNormal,u_sunDir);
    float dayMix=smoothstep(-0.2,0.2,sunLight);
    vec3 fogHoriz=mix(u_atmosHorizon*vec3(1.5,.6,.2), u_atmosHorizon, smoothstep(-0.1,0.3,sunLight));
    vec3 fogColor=mix(u_atmosZenith, fogHoriz, .8);
    fogColor+=vec3(1.,.8,.4)*pow(max(dot(-nv,u_sunDir),0.),8.)*dayMix;

    float camAlt=max(length(cameraPosition-u_planetCenter)-u_radius,0.);
    float thickness=u_radius*.25;
    float density=mix(.00015,.000005,clamp(camAlt/thickness,0.,1.))*u_atmosOpacity;
    float fogFactor=clamp(exp(-density*vdist),0.,1.);
    fogColor=mix(vec3(.01,.015,.04),fogColor,clamp(1.-camAlt/thickness,0.,1.));

    gl_FragColor=vec4(mix(fogColor,litColor,fogFactor),1.);
}`;

// ─── GPU ELEVATION READER ─────────────────────────────────────────────────────
const elevScene  = new THREE.Scene();
const elevCam    = new THREE.OrthographicCamera(-1,1,1,-1,-10,10);
const elevTarget = new THREE.WebGLRenderTarget(1,1,{format:THREE.RGBAFormat,type:THREE.UnsignedByteType});
const elevMat    = new THREE.ShaderMaterial({
    vertexShader: `void main(){gl_Position=vec4(position.xy,0.,1.);}`,
    fragmentShader: `
        ${CORE_MATH}
        uniform vec3 u_pos;
        void main(){
            float e=getSurfaceElevation(normalize(u_pos));
            float v=clamp((e+2.)/5.,0.,1.);
            vec3 enc=fract(vec3(1.,255.,65025.)*v);
            enc.xy-=enc.yz*(1./255.);
            gl_FragColor=vec4(enc,1.);
        }`,
    uniforms:{
        u_pos:{value:new THREE.Vector3()},
        u_seedOffset:{value:new THREE.Vector3()},
        u_terrainMode:{value:0.0},
        u_terrainParam:{value:3.0},
        u_terrainParam2:{value:0.15}
    },
    depthWrite:false, depthTest:false
});
const elevQuad = new THREE.Mesh(new THREE.PlaneGeometry(2,2), elevMat);
elevQuad.frustumCulled=false;
elevScene.add(elevQuad);
let lastGoodElev=0.08;

function getElevAt(nPos, renderer){
    elevMat.uniforms.u_pos.value.copy(nPos);
    const prev=renderer.getRenderTarget();
    renderer.setRenderTarget(elevTarget); renderer.clear();
    renderer.render(elevScene,elevCam);
    const buf=new Uint8Array(4);
    renderer.readRenderTargetPixels(elevTarget,0,0,1,1,buf);
    renderer.setRenderTarget(prev);
    if(!buf[0]&&!buf[1]&&!buf[2]) return lastGoodElev;
    let e=(buf[0]/255+buf[1]/65025+buf[2]/16581375)*5.-2.;
    if(!isNaN(e)&&e>-1.) lastGoodElev=e;
    return lastGoodElev;
}

// ─── QUADTREE LOD ─────────────────────────────────────────────────────────────
function buildChunkGeom(N) {
    const NP1 = N + 1;
    const verts = new Float32Array(NP1 * NP1 * 3);
    const idx = [];
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
        const v = (j * NP1 + i) * 3;
        verts[v] = i/N - 0.5; verts[v+1] = j/N - 0.5; verts[v+2] = 0;
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const a=j*NP1+i, b=a+1, c=a+NP1, d=c+1;
        idx.push(a,b,c, b,d,c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    return g;
}
const chunkGeom = buildChunkGeom(CHUNK_SEGMENTS);

class PlanetChunk {
    constructor(scene,center,axisA,axisB,level,matTpl,shared){
        this.scene=scene; this.center=center; this.axisA=axisA;
        this.axisB=axisB; this.level=level; this.children=[]; this.isSubdivided=false;
        this.material=matTpl.clone();
        // Re-attach shared uniforms by reference (clone() deep-copies, breaking share)
        for(const k of Object.keys(shared)) this.material.uniforms[k]=shared[k];
        this.material.uniforms.u_center.value=center;
        this.material.uniforms.u_axisA.value=axisA;
        this.material.uniforms.u_axisB.value=axisB;
        this.mesh=new THREE.Mesh(chunkGeom,this.material);
        this.mesh.frustumCulled=false;
        this.normalizedCenter=center.clone().normalize();
        scene.add(this.mesh);
    }
    update(camRelative, planetRadius){
        const dot=this.normalizedCenter.dot(camRelative.clone().normalize());
        const margin=Math.sin((Math.PI/2)/Math.pow(2,this.level))+0.2;
        if(dot<-margin){ this.mesh.visible=false; if(this.isSubdivided)this.merge(); return; }
        const camR=camRelative.length();
        const hDist=camRelative.clone().normalize().angleTo(this.normalizedCenter)*planetRadius;
        const altPen=Math.max(0,camR-(planetRadius+planetRadius*.15));
        const eDist=Math.sqrt(hDist*hDist+altPen*altPen);
        const thresh=planetRadius*(4.5/Math.pow(1.85,this.level));
        if(this.level<MAX_LOD_LEVEL&&eDist<thresh){
            if(!this.isSubdivided)this.subdivide();
            this.mesh.visible=false;
            for(const c of this.children)c.update(camRelative,planetRadius);
        } else {
            if(this.isSubdivided)this.merge();
            this.mesh.visible=true;
        }
    }
    subdivide(){
        this.isSubdivided=true;
        if(!this.children.length){
            const hA=this.axisA.clone().multiplyScalar(.5);
            const hB=this.axisB.clone().multiplyScalar(.5);
            const qA=this.axisA.clone().multiplyScalar(.25);
            const qB=this.axisB.clone().multiplyScalar(.25);
            const ctrs=[
                this.center.clone().sub(qA).sub(qB),this.center.clone().add(qA).sub(qB),
                this.center.clone().sub(qA).add(qB),this.center.clone().add(qA).add(qB)
            ];
            const shared={};
            for(const k of Object.keys(this.material.uniforms)){
                if(['u_center','u_axisA','u_axisB'].includes(k)) continue;
                shared[k]=this.material.uniforms[k]; // pass by reference
            }
            for(const c of ctrs)
                this.children.push(new PlanetChunk(this.scene,c,hA,hB,this.level+1,this.material,shared));
        } else {
            for(const c of this.children)c.mesh.visible=true;
        }
    }
    merge(){ this.isSubdivided=false; for(const c of this.children){c.mesh.visible=false;if(c.isSubdivided)c.merge();} }
    destroy(){ this.scene.remove(this.mesh); this.mesh.material.dispose(); for(const c of this.children)c.destroy(); }
}

// ─── PLANET TYPES ─────────────────────────────────────────────────────────────
const PLANET_TYPES = [
    { name:'Terran',    terrainMode:0, colorMode:0, walkable:true,  waterLevel:.09, snowLine:.54, erosionStr:.75, hasClouds:true,  cloudDensity:.52,
      deepWater:[.01,.07,.22],shallowWater:[.04,.38,.68],coast:[.80,.70,.48],lowland:[.28,.54,.20],midland:[.20,.42,.15],highland:[.18,.30,.13],snowColor:[.88,.92,.98],rockColor:[.42,.40,.37],atmosZenith:[.02,.05,.15],atmosHorizon:[.30,.60,1.],atmosOpacity:1.,emissiveColor:[0,0,0],emissiveStr:0,terrainParam:3.,terrainParam2:.15,dotHSL:[.57,.6,.5] },
    { name:'Jungle',    terrainMode:0, colorMode:0, walkable:true,  waterLevel:.12, snowLine:.65, erosionStr:.85, hasClouds:true,  cloudDensity:.70,
      deepWater:[.01,.06,.18],shallowWater:[.03,.30,.55],coast:[.55,.58,.30],lowland:[.15,.40,.10],midland:[.12,.32,.08],highland:[.10,.24,.07],snowColor:[.75,.85,.70],rockColor:[.22,.20,.16],atmosZenith:[.01,.04,.08],atmosHorizon:[.12,.45,.15],atmosOpacity:1.,emissiveColor:[0,0,0],emissiveStr:0,terrainParam:3.,terrainParam2:.15,dotHSL:[.30,.65,.35] },
    { name:'Savanna',   terrainMode:0, colorMode:3, walkable:true,  waterLevel:.04, snowLine:.75, erosionStr:.70, hasClouds:false, cloudDensity:.10,
      deepWater:[.18,.14,.04],shallowWater:[.45,.32,.12],coast:[.78,.62,.32],lowland:[.70,.55,.22],midland:[.58,.42,.16],highland:[.44,.30,.10],snowColor:[.80,.72,.55],rockColor:[.46,.34,.18],atmosZenith:[.06,.03,.00],atmosHorizon:[.75,.50,.18],atmosOpacity:.7,emissiveColor:[0,0,0],emissiveStr:0,terrainParam:3.,terrainParam2:.15,dotHSL:[.09,.6,.55] },
    { name:'Arid',      terrainMode:0, colorMode:3, walkable:true,  waterLevel:.04, snowLine:.74, erosionStr:.95, hasClouds:false, cloudDensity:0,
      deepWater:[.15,.10,.05],shallowWater:[.40,.28,.10],coast:[.78,.62,.36],lowland:[.72,.52,.26],midland:[.60,.37,.16],highland:[.48,.28,.12],snowColor:[.82,.76,.62],rockColor:[.52,.36,.20],atmosZenith:[.08,.04,.01],atmosHorizon:[.80,.42,.12],atmosOpacity:.8,emissiveColor:[0,0,0],emissiveStr:0,terrainParam:3.,terrainParam2:.15,dotHSL:[.07,.7,.55] },
    { name:'Dune',      terrainMode:4, colorMode:3, walkable:true,  waterLevel:.01, snowLine:.90, erosionStr:.20, hasClouds:false, cloudDensity:.05,
      deepWater:[.20,.15,.06],shallowWater:[.50,.36,.14],coast:[.82,.68,.38],lowland:[.78,.60,.28],midland:[.65,.46,.18],highland:[.50,.32,.12],snowColor:[.88,.80,.65],rockColor:[.55,.40,.22],atmosZenith:[.07,.04,.01],atmosHorizon:[.82,.48,.15],atmosOpacity:.6,emissiveColor:[0,0,0],emissiveStr:0,terrainParam:2.5,terrainParam2:.18,dotHSL:[.08,.75,.60] },
    { name:'Ocean',     terrainMode:0, colorMode:0, walkable:true,  waterLevel:.22, snowLine:.48, erosionStr:.40, hasClouds:true,  cloudDensity:.68,
      deepWater:[.01,.04,.20],shallowWater:[.02,.25,.60],coast:[.60,.55,.35],lowland:[.22,.50,.20],midland:[.18,.42,.18],highland:[.22,.34,.18],snowColor:[.90,.94,1.],rockColor:[.35,.34,.30],atmosZenith:[.01,.04,.12],atmosHorizon:[.18,.52,.95],atmosOpacity:1.,emissiveColor:[0,0,0],emissiveStr:0,terrainParam:3.,terrainParam2:.15,dotHSL:[.62,.75,.40] },
    { name:'Archipelago',terrainMode:0,colorMode:0, walkable:true,  waterLevel:.16, snowLine:.55, erosionStr:.60, hasClouds:true,  cloudDensity:.55,
      deepWater:[.01,.05,.22],shallowWater:[.03,.28,.62],coast:[.75,.68,.40],lowland:[.25,.52,.18],midland:[.20,.40,.14],highland:[.18,.28,.12],snowColor:[.88,.92,.98],rockColor:[.38,.36,.30],atmosZenith:[.02,.05,.14],atmosHorizon:[.25,.55,.92],atmosOpacity:1.,emissiveColor:[0,0,0],emissiveStr:0,terrainParam:3.,terrainParam2:.15,dotHSL:[.55,.65,.45] },
    { name:'Volcanic',  terrainMode:2, colorMode:1, walkable:true,  waterLevel:.05, snowLine:.82, erosionStr:.20, hasClouds:false, cloudDensity:0,
      deepWater:[.30,.02,.00],shallowWater:[.72,.10,.00],coast:[.20,.08,.04],lowland:[.10,.07,.06],midland:[.14,.09,.07],highland:[.18,.11,.07],snowColor:[.24,.14,.09],rockColor:[.09,.07,.06],atmosZenith:[.04,.01,.00],atmosHorizon:[.60,.18,.04],atmosOpacity:.7,emissiveColor:[1.,.25,.0],emissiveStr:.8,terrainParam:2.8,terrainParam2:.22,dotHSL:[.03,.85,.40] },
    { name:'Caldera',   terrainMode:1, colorMode:1, walkable:true,  waterLevel:.06, snowLine:.85, erosionStr:.10, hasClouds:false, cloudDensity:0,
      deepWater:[.35,.04,.00],shallowWater:[.80,.14,.00],coast:[.22,.10,.04],lowland:[.11,.08,.06],midland:[.15,.10,.07],highland:[.19,.12,.07],snowColor:[.28,.16,.10],rockColor:[.10,.08,.06],atmosZenith:[.05,.01,.00],atmosHorizon:[.65,.20,.05],atmosOpacity:.6,emissiveColor:[1.,.35,.0],emissiveStr:1.2,terrainParam:3.5,terrainParam2:.20,dotHSL:[.04,.90,.38] },
    { name:'Ice',       terrainMode:0, colorMode:2, walkable:true,  waterLevel:.14, snowLine:.28, erosionStr:.50, hasClouds:true,  cloudDensity:.38,
      deepWater:[.10,.20,.45],shallowWater:[.45,.65,.85],coast:[.76,.84,.94],lowland:[.76,.86,.96],midland:[.64,.78,.92],highland:[.52,.64,.82],snowColor:[.95,.97,1.],rockColor:[.50,.58,.72],atmosZenith:[.02,.04,.10],atmosHorizon:[.52,.70,.95],atmosOpacity:.9,emissiveColor:[0,0,0],emissiveStr:0,terrainParam:3.,terrainParam2:.15,dotHSL:[.58,.5,.78] },
    { name:'Frozen',    terrainMode:3, colorMode:2, walkable:true,  waterLevel:.10, snowLine:.20, erosionStr:.30, hasClouds:true,  cloudDensity:.30,
      deepWater:[.08,.18,.40],shallowWater:[.40,.60,.82],coast:[.72,.82,.92],lowland:[.80,.90,.98],midland:[.70,.82,.95],highland:[.60,.72,.90],snowColor:[.96,.98,1.],rockColor:[.55,.62,.78],atmosZenith:[.02,.05,.12],atmosHorizon:[.50,.68,.92],atmosOpacity:.85,emissiveColor:[0,0,0],emissiveStr:0,terrainParam:5.,terrainParam2:8.,dotHSL:[.57,.45,.82] },
    { name:'Barren',    terrainMode:0, colorMode:0, walkable:true,  waterLevel:.01, snowLine:.70, erosionStr:0,   hasClouds:false, cloudDensity:0,
      deepWater:[.10,.08,.06],shallowWater:[.20,.16,.12],coast:[.35,.28,.20],lowland:[.42,.36,.28],midland:[.32,.27,.21],highland:[.24,.20,.16],snowColor:[.55,.50,.44],rockColor:[.22,.18,.14],atmosZenith:[0,0,0],atmosHorizon:[0,0,0],atmosOpacity:0,emissiveColor:[0,0,0],emissiveStr:0,terrainParam:3.,terrainParam2:.15,dotHSL:[.06,.12,.45] },
    { name:'Cratered',  terrainMode:1, colorMode:0, walkable:true,  waterLevel:.01, snowLine:.80, erosionStr:0,   hasClouds:false, cloudDensity:0,
      deepWater:[.08,.07,.05],shallowWater:[.18,.14,.10],coast:[.32,.25,.18],lowland:[.38,.32,.24],midland:[.28,.24,.18],highland:[.22,.18,.14],snowColor:[.50,.46,.40],rockColor:[.20,.16,.12],atmosZenith:[0,0,0],atmosHorizon:[0,0,0],atmosOpacity:0,emissiveColor:[0,0,0],emissiveStr:0,terrainParam:4.,terrainParam2:.18,dotHSL:[.07,.10,.38] },
    { name:'Metallic',  terrainMode:0, colorMode:0, walkable:true,  waterLevel:.02, snowLine:.72, erosionStr:.15, hasClouds:false, cloudDensity:0,
      deepWater:[.20,.18,.14],shallowWater:[.42,.36,.24],coast:[.58,.50,.34],lowland:[.60,.52,.38],midland:[.50,.44,.30],highland:[.40,.34,.22],snowColor:[.72,.68,.60],rockColor:[.32,.28,.22],atmosZenith:[.01,.01,.01],atmosHorizon:[.12,.10,.08],atmosOpacity:.2,emissiveColor:[0,0,0],emissiveStr:0,terrainParam:3.,terrainParam2:.15,dotHSL:[.10,.20,.55] },
    { name:'Alien',     terrainMode:0, colorMode:4, walkable:true,  waterLevel:.08, snowLine:.60, erosionStr:.65, hasClouds:true,  cloudDensity:.44,
      deepWater:[.05,.15,.25],shallowWater:[.10,.35,.50],coast:[.35,.22,.42],lowland:[.42,.12,.52],midland:[.20,.06,.32],highland:[.52,.36,.14],snowColor:[.80,.58,.90],rockColor:[.24,.14,.30],atmosZenith:[.04,.00,.08],atmosHorizon:[.58,.18,.80],atmosOpacity:1.,emissiveColor:[0,0,0],emissiveStr:0,terrainParam:3.,terrainParam2:.15,dotHSL:[.80,.65,.52] },
    { name:'Crystal',   terrainMode:5, colorMode:4, walkable:true,  waterLevel:.02, snowLine:.85, erosionStr:.05, hasClouds:false, cloudDensity:0,
      deepWater:[.04,.12,.20],shallowWater:[.08,.28,.42],coast:[.30,.18,.38],lowland:[.38,.10,.48],midland:[.18,.05,.28],highland:[.50,.34,.12],snowColor:[.85,.62,.95],rockColor:[.22,.12,.28],atmosZenith:[.03,.00,.06],atmosHorizon:[.50,.15,.72],atmosOpacity:.8,emissiveColor:[.4,.1,.9],emissiveStr:.6,terrainParam:4.5,terrainParam2:.28,dotHSL:[.78,.70,.58] },
    { name:'Bioluminescent',terrainMode:0,colorMode:5,walkable:true,waterLevel:.08,snowLine:.60,erosionStr:.55,hasClouds:true,cloudDensity:.48,
      deepWater:[.02,.08,.14],shallowWater:[.04,.18,.28],coast:[.08,.14,.18],lowland:[.03,.06,.04],midland:[.02,.05,.03],highland:[.04,.06,.08],snowColor:[.06,.10,.12],rockColor:[.05,.05,.05],atmosZenith:[.00,.02,.04],atmosHorizon:[.02,.10,.18],atmosOpacity:.9,emissiveColor:[.0,.8,.4],emissiveStr:.5,terrainParam:3.,terrainParam2:.15,dotHSL:[.45,.70,.38] },
    { name:'Toxic',     terrainMode:3, colorMode:4, walkable:true,  waterLevel:.10, snowLine:.65, erosionStr:.50, hasClouds:true,  cloudDensity:.80,
      deepWater:[.08,.12,.02],shallowWater:[.22,.32,.04],coast:[.50,.48,.08],lowland:[.45,.52,.06],midland:[.35,.42,.04],highland:[.28,.35,.04],snowColor:[.65,.72,.20],rockColor:[.30,.28,.08],atmosZenith:[.04,.06,.00],atmosHorizon:[.45,.55,.08],atmosOpacity:1.2,emissiveColor:[0,0,0],emissiveStr:0,terrainParam:4.,terrainParam2:6.,dotHSL:[.22,.75,.45] },
    { name:'GasGiant',  terrainMode:3, colorMode:0, walkable:false, waterLevel:.50, snowLine:.10, erosionStr:0,   hasClouds:false, cloudDensity:0,
      deepWater:[.30,.18,.08],shallowWater:[.55,.38,.18],coast:[.62,.45,.25],lowland:[.58,.42,.22],midland:[.48,.34,.18],highland:[.38,.26,.14],snowColor:[.70,.60,.50],rockColor:[.32,.24,.16],atmosZenith:[.06,.04,.02],atmosHorizon:[.50,.35,.15],atmosOpacity:.5,emissiveColor:[0,0,0],emissiveStr:0,terrainParam:6.,terrainParam2:3.,dotHSL:[.08,.45,.62] }
];

// ─── NAMING ───────────────────────────────────────────────────────────────────
const _ONSETS=['Kr','Vel','Tar','Sol','Men','Ath','Dur','Zar','Per','Kal','Vor','Aer','Syl','Thr','Bel','Xen','Ost','Fal','Mir','Dun','Cet','Ral'];
const _NUCLEI=['an','os','ei','ar','um','is','on','al','en','or','ax','il','un','eth','ael','ior','aus','yn','ek','ub'];
const _CODAS=['','','','ix','as','or','um','is','ax','en','ys','ath','on','el','ar'];
const _SUFFIXES=['','','','','Prime','Minor','Major','Alpha','Beta','Gamma','Delta'];

function _syllable(rng){ return _ONSETS[Math.floor(rng()*_ONSETS.length)]+_NUCLEI[Math.floor(rng()*_NUCLEI.length)]+_CODAS[Math.floor(rng()*_CODAS.length)]; }
function generateSystemName(rng){
    const n=1+Math.floor(rng()*2);
    let s='';for(let i=0;i<n;i++)s+=_syllable(rng);
    const suf=_SUFFIXES[Math.floor(rng()*_SUFFIXES.length)];
    return s+(suf?' '+suf:'');
}
function generatePlanetName(sysName, idx, rng){
    const romans=['I','II','III','IV','V','VI'];
    return sysName+' '+(romans[idx]||'I');
}

// ─── VARIATION HELPERS ────────────────────────────────────────────────────────
function _lerp(a,b,t){return a+(b-a)*t;}
function _varyRGB(base, spread, rng){
    return base.map(v=>Math.max(0,Math.min(1, v+(_lerp(-spread,spread,rng())))));
}

// ─── GALAXY GENERATION ────────────────────────────────────────────────────────
const NUM_SYSTEMS   = 500;
const NEW_GALAXY_RADIUS = 30_000_000;
const MIN_SYS_SPACING   = 800_000;

const STAR_CLASSES=[
    {name:'O', weight:.001, color:[0.55,0.65,1.00], dotSize:12},
    {name:'B', weight:.01,  color:[0.72,0.82,1.00], dotSize:10},
    {name:'A', weight:.05,  color:[0.90,0.94,1.00], dotSize: 8},
    {name:'F', weight:.10,  color:[1.00,1.00,0.95], dotSize: 7},
    {name:'G', weight:.14,  color:[1.00,0.96,0.78], dotSize: 6},
    {name:'K', weight:.16,  color:[1.00,0.80,0.45], dotSize: 5},
    {name:'M', weight:.76,  color:[1.00,0.55,0.25], dotSize: 4},
    {name:'WD',weight:.02,  color:[0.85,0.90,1.00], dotSize: 3},
    {name:'NS',weight:.002, color:[0.70,0.85,1.00], dotSize: 3},
];
(function buildWeights(){
    let sum=0; STAR_CLASSES.forEach(s=>sum+=s.weight);
    let acc=0; STAR_CLASSES.forEach(s=>{s.cumW=(acc+=s.weight/sum);});
})();
function pickStarClass(rng){
    const r=rng(); for(const s of STAR_CLASSES)if(r<s.cumW)return s;
    return STAR_CLASSES[STAR_CLASSES.length-1];
}

function generateSystems(seedStr){
    const rng=makeRng(hashStr(seedStr));
    const systems=[];

    function makePlanetForSystem(sysId, sysPos, sysName, planetIdx, prng){
        const type=PLANET_TYPES[Math.floor(prng()*PLANET_TYPES.length)];
        const radius=3500+prng()*7000;
        const spread=0.02;
        const vary=a=>_varyRGB(a,spread,prng);
        // Per-planet variation: slight color tweaks
        const t=Object.assign({},type,{
            deepWater:vary(type.deepWater), shallowWater:vary(type.shallowWater),
            coast:vary(type.coast), lowland:vary(type.lowland), midland:vary(type.midland),
            highland:vary(type.highland), snowColor:vary(type.snowColor), rockColor:vary(type.rockColor),
            waterLevel: Math.max(0,type.waterLevel+(_lerp(-.03,.03,prng()))),
            snowLine:   Math.max(0.1,type.snowLine+(_lerp(-.06,.06,prng()))),
            erosionStr: Math.max(0,type.erosionStr+(_lerp(-.15,.15,prng()))),
            terrainParam: type.terrainParam*(0.85+prng()*.30),
        });
        const seedOff=new THREE.Vector3(prng()*200-100,prng()*200-100,prng()*200-100);
        const orbitR=(1+planetIdx)*100_000*(0.5+prng()*.8);
        const orbitA=prng()*Math.PI*2;
        const orbitY=(prng()-0.5)*orbitR*0.5;
        const pos=sysPos.clone().add(new THREE.Vector3(Math.cos(orbitA)*orbitR, orbitY, Math.sin(orbitA)*orbitR));
        const dotH=t.dotHSL[0]+(prng()-.5)*.12;
        const c=new THREE.Color().setHSL(((dotH%1)+1)%1, t.dotHSL[1], t.dotHSL[2]);
        const name=generatePlanetName(sysName,planetIdx,prng);
        return { id:`${sysId}-${planetIdx}`, systemId:sysId, systemName:sysName,
                 position:pos, type:t, typeName:type.name, name, radius,
                 seedOffset:seedOff, color:c, dotSize:3+prng()*8,
                 orbitRadius:orbitR, orbitAngle:orbitA };
    }

    // System 0 at origin
    const sys0Name=generateSystemName(rng);
    const sys0Class=pickStarClass(rng);
    const sys0Planets=[];
    const nP0=2+Math.floor(rng()*3);
    const s0rng=makeRng(hashStr(seedStr+'sys0'));
    for(let i=0;i<nP0;i++) sys0Planets.push(makePlanetForSystem(0,new THREE.Vector3(),sys0Name,i,s0rng));
    systems.push({id:0,name:sys0Name,position:new THREE.Vector3(),starClass:sys0Class,color:new THREE.Color(...sys0Class.color),dotSize:sys0Class.dotSize,planets:sys0Planets});

    // Clustered spiral arms
    const NUM_CLUSTERS=8+Math.floor(rng()*5);
    const clusters=[];
    for(let c=0;c<NUM_CLUSTERS;c++){
        const arm=Math.floor(rng()*4);
        const r=(0.12+Math.pow(rng(),1.4)*.88)*NEW_GALAXY_RADIUS;
        const baseAngle=arm*(Math.PI*.5);
        const spiralTwist=(r/NEW_GALAXY_RADIUS)*Math.PI*.8;
        const angle=baseAngle+spiralTwist+(rng()-.5)*.6;
        const phi2=Math.acos(2*rng()-1);
        clusters.push({
            pos:new THREE.Vector3(r*Math.cos(angle), r*Math.cos(phi2)*0.7, r*Math.sin(angle)),
            spread:500_000+rng()*1_500_000,
            count:10+Math.floor(rng()*28)
        });
    }

    let attempts=0;
    for(const cl of clusters){
        let placed=0;
        while(placed<cl.count&&systems.length<NUM_SYSTEMS&&attempts<30000){
            attempts++;
            const u=rng()+1e-6,v=rng();
            const r=cl.spread*Math.sqrt(-2*Math.log(u));
            const theta=v*Math.PI*2;
            const phi=Math.acos(2*rng()-1);
            const offset=new THREE.Vector3(r*Math.sin(phi)*Math.cos(theta),r*Math.sin(phi)*Math.sin(theta),r*Math.cos(phi));
            const pos=cl.pos.clone().add(offset);
            if(pos.length()>NEW_GALAXY_RADIUS*1.1) continue;
            let ok=true;
            for(const s of systems) if(pos.distanceTo(s.position)<MIN_SYS_SPACING){ok=false;break;}
            if(!ok) continue;
            const sid=systems.length;
            const sName=generateSystemName(rng);
            const sClass=pickStarClass(rng);
            const srng=makeRng(hashStr(seedStr+'sys'+sid));
            const nPl=1+Math.floor(srng()*6);
            const planets=[];
            for(let i=0;i<nPl;i++) planets.push(makePlanetForSystem(sid,pos,sName,i,srng));
            systems.push({id:sid,name:sName,position:pos,starClass:sClass,color:new THREE.Color(...sClass.color),dotSize:sClass.dotSize,planets});
            placed++;
        }
    }
    while(systems.length<NUM_SYSTEMS&&attempts<60000){
        attempts++;
        const theta=rng()*Math.PI*2,phi=Math.acos(2*rng()-1);
        const r=Math.pow(rng(),1.6)*NEW_GALAXY_RADIUS;
        const pos=new THREE.Vector3(r*Math.sin(phi)*Math.cos(theta),r*Math.sin(phi)*Math.sin(theta),r*Math.cos(phi));
        let ok=true;
        for(const s of systems) if(pos.distanceTo(s.position)<MIN_SYS_SPACING*1.5){ok=false;break;}
        if(!ok) continue;
        const sid=systems.length;
        const sName=generateSystemName(rng);
        const sClass=pickStarClass(rng);
        const srng=makeRng(hashStr(seedStr+'sys'+sid));
        const nPl=1+Math.floor(srng()*6);
        const planets=[];
        for(let i=0;i<nPl;i++) planets.push(makePlanetForSystem(sid,pos,sName,i,srng));
        systems.push({id:sid,name:sName,position:pos,starClass:sClass,color:new THREE.Color(...sClass.color),dotSize:sClass.dotSize,planets});
    }
    return systems;
}

// ─── APP STATE ────────────────────────────────────────────────────────────────
const CUBE_FACES=[
    {c:new THREE.Vector3(0,0,1), a:new THREE.Vector3(2,0,0), b:new THREE.Vector3(0,2,0)},
    {c:new THREE.Vector3(0,0,-1),a:new THREE.Vector3(-2,0,0),b:new THREE.Vector3(0,2,0)},
    {c:new THREE.Vector3(1,0,0), a:new THREE.Vector3(0,0,-2),b:new THREE.Vector3(0,2,0)},
    {c:new THREE.Vector3(-1,0,0),a:new THREE.Vector3(0,0,2), b:new THREE.Vector3(0,2,0)},
    {c:new THREE.Vector3(0,1,0), a:new THREE.Vector3(2,0,0), b:new THREE.Vector3(0,0,-2)},
    {c:new THREE.Vector3(0,-1,0),a:new THREE.Vector3(2,0,0), b:new THREE.Vector3(0,0,2)}
];

let scene, camera, renderer, controls;
let galaxySystems=[], allPlanetsFlat=[], focusedSysIdx=0, focusedPlIdx=0, rootChunks=[];
let atmosMesh, cloudMesh, dotGeom, dotMat, dotPoints;
let baseMaterial, atmosMat, cloudMatRef;
let sharedU;
let activePlanetRadius=BASE_RADIUS;
let transitioning=false, transitionT=0;
let transitionStartCam, transitionEndCam, transitionStartTgt, transitionEndTgt;
let isWalking=false, canWalk=false, camYaw=0, camPitch=0;
const keys={};
const sunDir=new THREE.Vector3(1,.8,.5).normalize();
const _proj=new THREE.Vector3();

function focusedPlanet(){ return (galaxySystems[focusedSysIdx]||{planets:[]}).planets[focusedPlIdx]; }

// ─── FOCUS PLANET ─────────────────────────────────────────────────────────────
function focusPlanet(sysIdx, plIdx, immediate=false){
    focusedSysIdx=sysIdx; focusedPlIdx=plIdx;
    const pl=focusedPlanet();
    if(!pl) return;

    // Destroy current LOD
    for(const c of rootChunks) c.destroy();
    rootChunks=[]; lastGoodElev=.08;

    const t=pl.type;
    activePlanetRadius=pl.radius;

    // Update shared uniforms — single object mutated, all chunks see change
    sharedU.seedOffset.value.copy(pl.seedOffset);
    sharedU.planetCenter.value.copy(pl.position);
    sharedU.radius.value=pl.radius;
    sharedU.waterLevel.value=t.waterLevel;
    sharedU.snowLine.value=t.snowLine;
    sharedU.erosionStr.value=t.erosionStr;
    sharedU.deepWater.value.set(...t.deepWater);
    sharedU.shallowWater.value.set(...t.shallowWater);
    sharedU.coast.value.set(...t.coast);
    sharedU.lowland.value.set(...t.lowland);
    sharedU.midland.value.set(...t.midland);
    sharedU.highland.value.set(...t.highland);
    sharedU.snowColor.value.set(...t.snowColor);
    sharedU.rockColor.value.set(...t.rockColor);
    sharedU.atmosZenith.value.set(...t.atmosZenith);
    sharedU.atmosHorizon.value.set(...t.atmosHorizon);
    sharedU.atmosOpacity.value=t.atmosOpacity;
    sharedU.terrainMode.value=t.terrainMode||0;
    sharedU.terrainParam.value=t.terrainParam||3.0;
    sharedU.terrainParam2.value=t.terrainParam2||0.15;
    sharedU.colorMode.value=t.colorMode||0;
    sharedU.emissiveColor.value.set(...(t.emissiveColor||[0,0,0]));
    sharedU.emissiveStr.value=t.emissiveStr||0;

    // Elevation reader seed + terrain mode
    elevMat.uniforms.u_seedOffset.value.copy(pl.seedOffset);
    elevMat.uniforms.u_terrainMode.value=t.terrainMode||0;
    elevMat.uniforms.u_terrainParam.value=t.terrainParam||3.0;
    elevMat.uniforms.u_terrainParam2.value=t.terrainParam2||0.15;

    // Atmosphere + cloud meshes follow planet
    atmosMesh.position.copy(pl.position);
    atmosMesh.scale.setScalar(pl.radius/BASE_RADIUS);
    atmosMat.uniforms.u_planetCenter.value.copy(pl.position);
    atmosMat.uniforms.u_radius.value=pl.radius;
    atmosMat.uniforms.u_atmosZenith.value.set(...t.atmosZenith);
    atmosMat.uniforms.u_atmosHorizon.value.set(...t.atmosHorizon);
    atmosMat.uniforms.u_atmosOpacity.value=t.atmosOpacity;

    cloudMesh.position.copy(pl.position);
    cloudMesh.scale.setScalar(pl.radius/BASE_RADIUS);
    cloudMesh.visible=t.hasClouds;
    cloudMatRef.uniforms.u_seedOffset.value.copy(pl.seedOffset);
    cloudMatRef.uniforms.u_cloudDensity.value=t.cloudDensity;

    // Build LOD
    for(const f of CUBE_FACES)
        rootChunks.push(new PlanetChunk(scene,f.c,f.a,f.b,0,baseMaterial,sharedU));

    // Hide focused planet dot, show all others
    if(dotGeom){
        const col=dotGeom.attributes.color.array;
        const siz=dotGeom.attributes.size.array;
        allPlanetsFlat.forEach((entry,i)=>{
            const hide=(entry.sysIdx===sysIdx&&entry.plIdx===plIdx);
            col[i*3]=hide?0:entry.planet.color.r;
            col[i*3+1]=hide?0:entry.planet.color.g;
            col[i*3+2]=hide?0:entry.planet.color.b;
            siz[i]=hide?0:entry.planet.dotSize;
        });
        dotGeom.attributes.color.needsUpdate=true;
        dotGeom.attributes.size.needsUpdate=true;
    }

    if(!immediate){
        const vd=camera.position.clone().sub(controls.target).normalize();
        transitionStartCam=camera.position.clone();
        transitionStartTgt=controls.target.clone();
        transitionEndTgt=pl.position.clone();
        transitionEndCam=pl.position.clone().add(vd.multiplyScalar(pl.radius*3.5));
        transitioning=true; transitionT=0;
    } else {
        controls.target.copy(pl.position);
        camera.position.copy(pl.position).add(new THREE.Vector3(0,0,pl.radius*3.5));
    }

    const sys=galaxySystems[sysIdx];
    document.getElementById('system-text').textContent=`System: ${sys.name} (${sys.starClass.name}-class)`;
    document.getElementById('planet-text').textContent=`Planet: ${pl.name}`;
    document.getElementById('planet-type-text').textContent=`Type: ${pl.typeName}`;
    document.getElementById('planet-nav-text').textContent=`← → cycle ${sys.planets.length} planets in ${sys.name}`;
    if(t.walkable===false){
        canWalk=false; document.getElementById('walk-prompt').style.display='none';
    }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
function init(){
    scene=new THREE.Scene();
    camera=new THREE.PerspectiveCamera(45,innerWidth/innerHeight,.5,NEW_GALAXY_RADIUS*4);
    camera.position.set(0,0,BASE_RADIUS*3.5);

    renderer=new THREE.WebGLRenderer({antialias:true, logarithmicDepthBuffer:true});
    renderer.setSize(innerWidth,innerHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
    document.body.appendChild(renderer.domElement);

    controls=new THREE.OrbitControls(camera,renderer.domElement);
    controls.enableDamping=true; controls.dampingFactor=.05;
    controls.maxDistance=NEW_GALAXY_RADIUS*3.5;

    // Lights for dot mesh
    scene.add(new THREE.AmbientLight(0x334455,.9));
    const dl=new THREE.DirectionalLight(0xfff0dd,1.2);
    dl.position.copy(sunDir); scene.add(dl);

    // Sun sphere
    const sunMesh=new THREE.Mesh(new THREE.SphereGeometry(200,16,16),new THREE.MeshBasicMaterial({color:0xffeebb}));
    sunMesh.position.copy(sunDir).multiplyScalar(BASE_RADIUS*3.5);
    scene.add(sunMesh);

    // Shared uniform objects — mutated in focusPlanet, shared by reference with chunks
    sharedU={
        seedOffset:   {value:new THREE.Vector3()},
        planetCenter: {value:new THREE.Vector3()},
        sunDir:       {value:sunDir},
        radius:       {value:BASE_RADIUS},
        waterLevel:   {value:.09},
        snowLine:     {value:.54},
        erosionStr:   {value:.75},
        deepWater:    {value:new THREE.Vector3()},
        shallowWater: {value:new THREE.Vector3()},
        coast:        {value:new THREE.Vector3()},
        lowland:      {value:new THREE.Vector3()},
        midland:      {value:new THREE.Vector3()},
        highland:     {value:new THREE.Vector3()},
        snowColor:    {value:new THREE.Vector3()},
        rockColor:    {value:new THREE.Vector3()},
        atmosZenith:  {value:new THREE.Vector3()},
        atmosHorizon: {value:new THREE.Vector3()},
        atmosOpacity: {value:1.0},
        terrainMode:  {value:0.0},
        terrainParam: {value:3.0},
        terrainParam2:{value:0.15},
        colorMode:    {value:0.0},
        emissiveColor:{value:new THREE.Vector3()},
        emissiveStr:  {value:0.0},
    };

    // Atmosphere
    atmosMat=new THREE.ShaderMaterial({
        vertexShader:ATMOS_VERT, fragmentShader:ATMOS_FRAG,
        uniforms:{
            u_sunDir:{value:sunDir}, u_radius:{value:BASE_RADIUS},
            u_planetCenter:{value:new THREE.Vector3()},
            u_atmosZenith:{value:new THREE.Vector3(.02,.05,.15)},
            u_atmosHorizon:{value:new THREE.Vector3(.3,.6,1.)},
            u_atmosOpacity:{value:1.0}
        },
        transparent:true, side:THREE.BackSide, depthWrite:false
    });
    atmosMesh=new THREE.Mesh(new THREE.SphereGeometry(BASE_RADIUS*1.25,64,64),atmosMat);
    scene.add(atmosMesh);

    // Clouds
    cloudMatRef=new THREE.ShaderMaterial({
        vertexShader:CLOUD_VERT, fragmentShader:CLOUD_FRAG,
        uniforms:{u_seedOffset:{value:new THREE.Vector3()},u_sunDir:{value:sunDir},u_cloudDensity:{value:.52}},
        transparent:true, depthWrite:false
    });
    cloudMesh=new THREE.Mesh(new THREE.SphereGeometry(BASE_RADIUS*1.06,128,128),cloudMatRef);
    scene.add(cloudMesh);

    // Base material (shared with all chunks; type-specific uniforms added from sharedU)
    baseMaterial=new THREE.ShaderMaterial({
        vertexShader:VERT, fragmentShader:FRAG,
        side:THREE.FrontSide,
        uniforms:{
            u_center:     {value:new THREE.Vector3()},
            u_axisA:      {value:new THREE.Vector3()},
            u_axisB:      {value:new THREE.Vector3()},
            // These get overwritten by sharedU references in PlanetChunk constructor
            u_seedOffset: sharedU.seedOffset,
            u_planetCenter:sharedU.planetCenter,
            u_sunDir:     sharedU.sunDir,
            u_radius:     sharedU.radius,
            u_waterLevel: sharedU.waterLevel,
            u_snowLine:   sharedU.snowLine,
            u_erosionStr: sharedU.erosionStr,
            u_deepWater:  sharedU.deepWater,
            u_shallowWater:sharedU.shallowWater,
            u_coast:      sharedU.coast,
            u_lowland:    sharedU.lowland,
            u_midland:    sharedU.midland,
            u_highland:   sharedU.highland,
            u_snowColor:  sharedU.snowColor,
            u_rockColor:  sharedU.rockColor,
            u_atmosZenith:sharedU.atmosZenith,
            u_atmosHorizon:sharedU.atmosHorizon,
            u_atmosOpacity:sharedU.atmosOpacity,
            u_terrainMode: sharedU.terrainMode,
            u_terrainParam:sharedU.terrainParam,
            u_terrainParam2:sharedU.terrainParam2,
            u_colorMode:   sharedU.colorMode,
            u_emissiveColor:sharedU.emissiveColor,
            u_emissiveStr: sharedU.emissiveStr,
        }
    });

    // Single flat dot geometry for all planets
    const MAX_DOTS=3000;
    dotGeom=new THREE.BufferGeometry();
    dotGeom.setAttribute('position',new THREE.BufferAttribute(new Float32Array(MAX_DOTS*3),3));
    dotGeom.setAttribute('color',   new THREE.BufferAttribute(new Float32Array(MAX_DOTS*3),3));
    dotGeom.setAttribute('size',    new THREE.BufferAttribute(new Float32Array(MAX_DOTS),1));
    dotMat=new THREE.ShaderMaterial({
        transparent:true, depthWrite:false,
        vertexShader:`attribute float size; attribute vec3 color; varying vec3 vC;
            void main(){ vC=color; gl_PointSize=size; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
        fragmentShader:`varying vec3 vC;
            void main(){ vec2 uv=gl_PointCoord-.5; float r=length(uv); if(r>.5)discard; gl_FragColor=vec4(vC,1.-smoothstep(.2,.5,r));}`
    });
    dotPoints=new THREE.Points(dotGeom,dotMat);
    scene.add(dotPoints);

    function buildGalaxy(seedStr){
        galaxySystems=generateSystems(seedStr);
        // Flatten all planets into a single indexed list
        allPlanetsFlat=[];
        galaxySystems.forEach((sys,si)=>sys.planets.forEach((pl,pi)=>allPlanetsFlat.push({sysIdx:si,plIdx:pi,planet:pl})));

        const pos=dotGeom.attributes.position.array;
        const col=dotGeom.attributes.color.array;
        const siz=dotGeom.attributes.size.array;
        pos.fill(1e9); col.fill(0); siz.fill(0);
        allPlanetsFlat.forEach((entry,i)=>{
            const p=entry.planet;
            pos[i*3]=p.position.x; pos[i*3+1]=p.position.y; pos[i*3+2]=p.position.z;
            col[i*3]=p.color.r; col[i*3+1]=p.color.g; col[i*3+2]=p.color.b;
            siz[i]=p.dotSize;
        });
        dotGeom.attributes.position.needsUpdate=true;
        dotGeom.attributes.color.needsUpdate=true;
        dotGeom.attributes.size.needsUpdate=true;
        focusPlanet(0,0,true);
    }

    document.getElementById('seed-btn').addEventListener('click',e=>{
        e.stopPropagation();
        buildGalaxy(document.getElementById('seed-input').value||'RedTeam');
    });
    document.getElementById('seed-input').addEventListener('click',e=>e.stopPropagation());
    buildGalaxy('RedTeam');

    // Click — travel directly to any planet dot, or enter walk mode
    renderer.domElement.addEventListener('click',e=>{
        if(isWalking||transitioning) return;
        if(e.target.id==='seed-input'||e.target.id==='seed-btn') return;
        const cx=e.clientX, cy=e.clientY;
        let bestI=-1, bestD=20*20;
        allPlanetsFlat.forEach((entry,i)=>{
            if(entry.sysIdx===focusedSysIdx&&entry.plIdx===focusedPlIdx) return;
            _proj.copy(entry.planet.position).project(camera);
            if(_proj.z>1) return;
            const sx=(_proj.x*.5+.5)*innerWidth, sy=(-.5*_proj.y+.5)*innerHeight;
            const d=(sx-cx)**2+(sy-cy)**2;
            if(d<bestD){bestD=d;bestI=i;}
        });
        if(bestI>=0){ const e2=allPlanetsFlat[bestI]; focusPlanet(e2.sysIdx,e2.plIdx); return; }
        if(canWalk) document.body.requestPointerLock();
    });

    window.addEventListener('resize',()=>{
        camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix();
        renderer.setSize(innerWidth,innerHeight);
    });
    const setKey=(e,d)=>{
        if(!isWalking) return;
        if(e.code==='KeyW'||e.code==='ArrowUp')   keys.fwd=d;
        if(e.code==='KeyS'||e.code==='ArrowDown')  keys.bwd=d;
        if(e.code==='KeyA')  keys.lft=d;
        if(e.code==='KeyD')  keys.rgt=d;
    };
    document.addEventListener('keydown',e=>{
        setKey(e,true);
        if(!isWalking&&!transitioning){
            const sys=galaxySystems[focusedSysIdx];
            if(!sys) return;
            const n=sys.planets.length;
            if(e.code==='ArrowLeft')  focusPlanet(focusedSysIdx,(focusedPlIdx-1+n)%n);
            if(e.code==='ArrowRight') focusPlanet(focusedSysIdx,(focusedPlIdx+1)%n);
        }
    });
    document.addEventListener('keyup',  e=>setKey(e,false));
    document.addEventListener('mousemove',e=>{
        if(!isWalking||document.pointerLockElement!==document.body) return;
        camYaw  -=e.movementX*.002;
        camPitch-=e.movementY*.002;
        camPitch=Math.max(-Math.PI/2+.1,Math.min(Math.PI/2-.1,camPitch));
    });
    document.addEventListener('pointerlockchange',()=>{
        if(document.pointerLockElement===document.body){
            isWalking=true; controls.enabled=false;
            document.getElementById('mode-text').textContent='Mode: First-Person Walking';
            document.getElementById('hint-text').textContent='WASD to move · ESC to exit';
            document.getElementById('walk-prompt').style.display='none';
            document.getElementById('crosshair').style.display='block';
            camYaw=0; camPitch=0;
        } else {
            isWalking=false; controls.enabled=true;
            keys.fwd=keys.bwd=keys.lft=keys.rgt=false;
            document.getElementById('mode-text').textContent='Mode: Orbit';
            document.getElementById('hint-text').textContent='Scroll to zoom · Click any planet to travel';
            document.getElementById('crosshair').style.display='none';
            camera.position.multiplyScalar(1.05);
        }
    });

    animate();
}

// ─── ANIMATE ──────────────────────────────────────────────────────────────────
function animate(){
    requestAnimationFrame(animate);
    const pl=focusedPlanet();
    const pr=activePlanetRadius;

    if(transitioning){
        transitionT+=TRANSITION_SPEED;
        const t=smoothstep01(transitionT);
        camera.position.lerpVectors(transitionStartCam,transitionEndCam,t);
        controls.target.lerpVectors(transitionStartTgt,transitionEndTgt,t);
        if(transitionT>=1){ transitioning=false; controls.update(); }
    } else if(isWalking){
        const pp=pl.position;
        const up=camera.position.clone().sub(pp).normalize();
        if(Math.abs(up.y+1.)<.001) up.z+=.001; up.normalize();
        const aq=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),up);
        const yq=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),camYaw);
        const pq=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),camPitch);
        camera.quaternion.copy(aq).multiply(yq).multiply(pq);
        const fwd=new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);
        const rgt=new THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion);
        fwd.sub(up.clone().multiplyScalar(fwd.dot(up))).normalize();
        rgt.sub(up.clone().multiplyScalar(rgt.dot(up))).normalize();
        const mv=new THREE.Vector3();
        if(keys.fwd)mv.add(fwd);if(keys.bwd)mv.sub(fwd);
        if(keys.rgt)mv.add(rgt);if(keys.lft)mv.sub(rgt);
        if(mv.lengthSq()>0){ mv.normalize(); camera.position.addScaledVector(mv,1.); }
        const nn=camera.position.clone().sub(pp).normalize();
        const elev=getElevAt(nn,renderer);
        const gr=pr+(elev*pr*.08);
        const cr=camera.position.clone().sub(pp).length();
        camera.position.copy(pp).addScaledVector(nn,cr+(gr+2.-cr)*.15);
    } else {
        controls.update();
        if(pl){
            const off=camera.position.clone().sub(pl.position);
            const elev=getElevAt(off.clone().normalize(),renderer);
            const gr=pr+elev*pr*.08;
            controls.minDistance=gr+2.;
            const dist=off.length();
            const walkable=(pl.type.walkable!==false);
            if(walkable&&dist-gr<20.){ canWalk=true; document.getElementById('walk-prompt').style.display='block'; }
            else { canWalk=false; document.getElementById('walk-prompt').style.display='none'; }
        }
    }

    if(pl&&!transitioning){
        const camRel=camera.position.clone().sub(pl.position);
        for(const c of rootChunks) c.update(camRel,pr);
    }

    renderer.render(scene,camera);
}

window.onload=init;
