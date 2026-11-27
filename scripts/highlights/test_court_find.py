"""Tests of the court finder (court_find.py).

run: python -m unittest scripts/highlights/test_court_find.py      (numpy, scipy, opencv-python-headless; about 40 s)

Two kinds of input, and no picture of a real place in the repository:
- court_find_lines.json: the line samples court_find.py found on three stored films (numbers only), and the camera
  it fitted then. The fit must find that camera again from a start that is off.
- a made-up court, drawn here from a known camera: grey floor, white lines, the net, dark outside the walls. The
  whole finder must find the camera from the picture, and must say "not sure" when the picture moves or has no court.
"""
import json, math, os, sys, unittest
import numpy as np, cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import court_find as cf

FIX = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'court_find_lines.json')))
TRUE_CAM = [880.0, 4.9, -0.2, 2.35, math.radians(0.8), math.radians(19.8), math.radians(0.2), 0.0]


def draw_court(cam, seed=0, size=(1920, 1080)):
    """A made-up picture of a padel court seen by cam (k1 = 0): every pixel's ray meets the floor or the net."""
    W, H = size; rng = np.random.default_rng(seed)
    u, v = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    d_cam = np.stack([(u - W / 2) / cam.f, (v - H / 2) / cam.f, np.ones_like(u)], -1)
    d = d_cam @ cam.R                                 # world directions (rows of R.T)
    C = cam.C
    with np.errstate(divide='ignore', invalid='ignore'):
        s = np.where(d[..., 2] < 0, -C[2] / d[..., 2], np.inf)
    X, Y = C[0] + s * d[..., 0], C[1] + s * d[..., 1]
    img = np.full((H, W), 175.0)                      # the hall above the floor
    floor = np.isfinite(s)
    court = floor & (X >= 0) & (X <= 10) & (Y >= 0) & (Y <= 20)
    img[floor] = 60.0                                 # outside the walls: dark
    img[court] = 120.0
    paint = court & ((np.abs(Y - cf.SVC_Y) < 0.03) | (np.abs(Y - cf.FAR_SVC_Y) < 0.03)
                     | ((np.abs(X - 5) < 0.03) & (Y > cf.SVC_Y - 0.2) & (Y < cf.FAR_SVC_Y)))
    img[paint] = 235.0
    with np.errstate(divide='ignore', invalid='ignore'):
        sn = (cf.NET_Y - C[1]) / d[..., 1]
    Xn, Zn = C[0] + sn * d[..., 0], C[2] + sn * d[..., 2]
    top = cf.NET_POST_Z - (cf.NET_POST_Z - cf.NET_MID_Z) * (1 - ((Xn - 5) / 5) ** 2)
    net = (sn > 0) & (sn < s) & (Xn >= 0) & (Xn <= 10) & (Zn >= 0) & (Zn <= top)
    img[net] *= 0.55                                  # the mesh darkens what is behind it
    img[net & (Zn > top - 0.05)] = 235.0              # the white band
    img += rng.normal(0, 4, img.shape)
    return cv2.cvtColor(np.clip(img, 0, 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)


class Geometry(unittest.TestCase):
    def test_angles_undo_rot(self):
        for ypr in [(0.01, 0.33, -0.01), (-0.2, 0.1, 0.05), (0.3, 0.6, -0.2)]:
            self.assertTrue(np.allclose(cf.angles(cf.rot(*ypr)), ypr, atol=1e-9))

    def test_homography_is_the_cameras_floor(self):
        cam = cf.Camera(TRUE_CAM)
        P = np.array([(0, 10), (10, 10), (5, 3.05), (0, 20), (7, 15)], float)
        q = (cam.H() @ np.c_[P, np.ones(len(P))].T).T
        self.assertTrue(np.allclose(q[:, :2] / q[:, 2:], cam.project(P), atol=1e-6))

    def test_camera_for_gives_back_the_camera(self):
        """From the three lines alone, a known focal length and tilt give the camera back."""
        cam = cf.Camera(TRUE_CAM)
        line = lambda P: cf.fit_line(cam.project(P))
        svc = line(cf._seg((0, cf.SVC_Y, 0), (10, cf.SVC_Y, 0), 10))
        ctr = line(cf._seg((5, cf.SVC_Y, 0), (5, cf.NET_Y, 0), 10))
        tape = line(cf.tape_points(11))
        dy = cam.R[:, 1]                     # the court's Y direction in the camera: it rises by the tilt
        c2 = cf.camera_for(cam.f, math.atan2(-dy[1], dy[2]), svc, ctr, tape)
        self.assertLess(np.abs(cf.key_points(c2)[:6] - cf.key_points(cam)[:6]).max(), 3.0)   # the posts, the T, the far corners


class RecordedLines(unittest.TestCase):
    """The fit on the line samples of the stored films finds their camera again, and the checks pass."""

    def test_fit_finds_the_recorded_camera(self):
        for name, film in FIX['films'].items():
            with self.subTest(film=name):
                obs = {k: np.array(v) for k, v in film['samples'].items()}
                p = np.array(film['camera']); p[0] *= 1.06; p[5] += math.radians(1.0); p[3] += 0.1
                cam = cf.fit_camera(obs, cf.Camera(p))
                cam = cf.fit_camera(obs, cam)
                got, want = cf.key_points(cam)[:6], np.array(film['key_points'])[:6]
                self.assertLess(np.abs(got - want).max(), 8.0, name)
                j = cf.judge(cam, obs)
                self.assertTrue(j['ok'], (name, j['reason'], j['detail']))
                self.assertLess(j['checks']['rms'], 2.5)

    def test_moved_samples_are_fit_poor(self):
        """The band's samples 15 px off: the lines no longer agree with one court."""
        film = FIX['films']['film_c_wide_high']
        obs = {k: np.array(v) for k, v in film['samples'].items()}
        obs['tape'] = obs['tape'] + [0, 15]
        cam = cf.Camera(film['camera']); cam.sag = film['sag']
        j = cf.judge(cam, obs)
        self.assertFalse(j['ok']); self.assertEqual(j['reason'], 'fit_poor')

    def test_missing_wall_is_not_sure(self):
        film = FIX['films']['film_b_wide_high']
        obs = {k: np.array(v) for k, v in film['samples'].items() if k != 'right'}
        cam = cf.Camera(film['camera']); cam.sag = film['sag']
        self.assertEqual(cf.judge(cam, obs)['reason'], 'walls_not_found')

    def test_implausible_camera(self):
        film = FIX['films']['film_c_wide_high']
        p = np.array(film['camera']); p[3] = 6.0           # a lens 6 m above the floor is no phone behind the glass
        self.assertTrue(cf.camera_check(cf.Camera(p)))

    def test_court_fields_are_what_court_py_reads(self):
        film = FIX['films']['film_c_wide_high']
        cam = cf.Camera(film['camera']); cam.sag = film['sag']
        c = cf.court_fields(cam)
        for k in ('NET_FOOT_Y', 'FAR_TOP_Y', 'FAR_L0', 'FAR_R0', 'POST_L', 'POST_R', 'SIDE_SLOPE', 'WALL_OUT_Y',
                  'FAR_H0', 'FAR_H1', 'TILES', 'H', 'camera'):
            self.assertIn(k, c)
        self.assertLess(c['FAR_TOP_Y'], c['NET_FOOT_Y'])
        self.assertLess(c['POST_L'], c['FAR_L0']); self.assertLess(c['FAR_R0'], c['POST_R'])
        self.assertTrue(all(len(t) == 4 for t in c['TILES']))
        json.dumps(c)


class MadeUpCourt(unittest.TestCase):
    """The whole finder on drawn pictures."""

    @classmethod
    def setUpClass(cls):
        cls.cam = cf.Camera(TRUE_CAM)
        cls.frames = [draw_court(cls.cam, seed=i) for i in range(9)]

    def test_finds_the_court(self):
        rep = cf.find_court(self.frames)
        rep.pop('_whole')
        self.assertEqual(rep['status'], 'ok', (rep['reason'], rep['detail']))
        c = rep['court']; want = cf.court_fields(self.cam)
        for k in ('NET_FOOT_Y', 'FAR_TOP_Y', 'POST_L', 'POST_R', 'FAR_L0', 'FAR_R0', 'WALL_OUT_Y'):
            self.assertLessEqual(abs(c[k] - want[k]), 6, k)

    def test_phone_that_moved(self):
        M = np.float32([[1, 0, 24], [0, 1, 12]])
        frames = self.frames[:6] + [cv2.warpAffine(f, M, (1920, 1080), borderMode=cv2.BORDER_REPLICATE) for f in self.frames[6:]]
        rep = cf.find_court(frames)
        self.assertEqual(rep['status'], 'not_sure'); self.assertEqual(rep['reason'], 'moved')

    def test_no_court(self):
        rng = np.random.default_rng(1)
        frames = [np.clip(rng.normal(120, 20, (1080, 1920, 3)), 0, 255).astype(np.uint8) for _ in range(9)]
        rep = cf.find_court(frames)
        self.assertEqual(rep['status'], 'not_sure'); self.assertEqual(rep['reason'], 'lines_not_found')

    def test_too_few_frames(self):
        rep = cf.find_court(self.frames[:2])
        self.assertEqual(rep['reason'], 'too_few_frames')


if __name__ == '__main__':
    unittest.main()
